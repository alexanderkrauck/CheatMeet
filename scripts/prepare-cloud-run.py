"""Prepare a no-traffic container revision without exposing service env values."""
import copy
import json
import os
import re
import sys

NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
SECRET = re.compile(r"^[A-Za-z0-9_-]{1,255}$")
# Settings the deploy never overrides: the runtime mode is set separately below.
RESERVED = {"NODE_ENV"}


def managed_from_environment(environ):
    """The MCP settings a deploy owns, taken from the workflow's environment.

    Both are optional together: the feature is off unless the app has a public
    URL AND a token secret, so a secret on its own is a misconfiguration.
    """
    plain, secrets = {}, {}
    url = (environ.get("MCP_PUBLIC_URL") or "").strip()
    secret = (environ.get("MCP_TOKEN_SECRET_NAME") or "").strip()
    if url:
        plain["MCP_PUBLIC_URL"] = url
    if secret:
        if not url:
            raise ValueError("MCP_TOKEN_SECRET_NAME needs MCP_PUBLIC_URL; refusing a half-enabled feature.")
        secrets["MCP_TOKEN_SECRET"] = secret
    processing = {name: (environ.get(name) or "").strip() for name in (
        "PROCESSING_QUEUE", "PROCESSING_WORKER_URL", "PROCESSING_SERVICE_ACCOUNT"
    )}
    if any(processing.values()):
        if not all(processing.values()):
            raise ValueError("Server processing needs queue, worker URL and service account together.")
        plain.update(processing)
    return plain, secrets


def prepare(service, image, revision, plain=None, secrets=None):
    result = {
        "apiVersion": service["apiVersion"],
        "kind": "Service",
        "metadata": {
            key: copy.deepcopy(value)
            for key, value in service["metadata"].items()
            if key in ("name", "namespace", "labels", "annotations", "resourceVersion")
        },
        "spec": copy.deepcopy(service["spec"]),
    }
    annotations = result["metadata"].get("annotations", {})
    for key in (
        "run.googleapis.com/urls", "run.googleapis.com/ingress-status",
        "run.googleapis.com/operation-id", "serving.knative.dev/creator",
        "serving.knative.dev/lastModifier",
    ):
        annotations.pop(key, None)
    template = result["spec"]["template"]
    template["metadata"]["name"] = revision
    for key in ("run.googleapis.com/sources", "run.googleapis.com/base-images"):
        template["metadata"].get("annotations", {}).pop(key, None)
    template["spec"].pop("runtimeClassName", None)
    containers = template["spec"]["containers"]
    if len(containers) != 1:
        raise ValueError("Review deployment configuration before deploying a multi-container service.")
    container = containers[0]
    container["image"] = image
    container["command"] = ["node"]
    container["args"] = ["dist/server.cjs"]
    env = container.setdefault("env", [])
    plain, secrets = plain or {}, secrets or {}
    for name, value in plain.items():
        if not NAME.match(name) or name in RESERVED or not isinstance(value, str):
            raise ValueError(f"Unsafe managed setting {name!r}.")
    for name, secret in secrets.items():
        if not NAME.match(name) or name in RESERVED or not isinstance(secret, str) or not SECRET.match(secret):
            raise ValueError(f"Unsafe managed secret {name!r}.")
    managed = set(plain) | set(secrets)
    env[:] = [item for item in env if item["name"] != "NODE_ENV" and item["name"] not in managed]
    env.append({"name": "NODE_ENV", "value": "production"})
    # Secrets are referenced by name; the value never passes through this script.
    for name, value in plain.items():
        env.append({"name": name, "value": value})
    for name, secret in secrets.items():
        env.append({"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": "latest"}}})
    # Freeze every currently serving revision; never route live traffic to
    # latestRevision while the candidate is being validated.
    traffic = []
    for target in service["status"]["traffic"]:
        if target.get("tag") == "candidate":
            if not target.get("percent"):
                continue
            target = {k: v for k, v in target.items() if k != "tag"}
        if not target.get("revisionName"):
            raise ValueError("Current traffic must resolve to an explicit revision.")
        if not isinstance(target.get("percent", 0), int) or not 0 <= target.get("percent", 0) <= 100:
            raise ValueError("Invalid current traffic percentage.")
        traffic.append({
            key: target[key]
            for key in ("revisionName", "percent", "tag")
            if key in target
        })
    if sum(item.get("percent", 0) for item in traffic) != 100:
        raise ValueError("Expected an existing service serving exactly 100 percent traffic.")
    traffic.append({"revisionName": revision, "percent": 0, "tag": "candidate"})
    result["spec"]["traffic"] = traffic
    return result


if __name__ == "__main__":
    json.dump(
        prepare(json.load(sys.stdin), sys.argv[1], sys.argv[2], *managed_from_environment(os.environ)),
        sys.stdout,
    )
