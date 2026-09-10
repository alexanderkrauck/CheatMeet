"""Prepare a no-traffic container revision without exposing service env values."""
import copy
import json
import sys


def prepare(service, image, revision):
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
    env[:] = [item for item in env if item["name"] != "NODE_ENV"]
    env.append({"name": "NODE_ENV", "value": "production"})
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
    json.dump(prepare(json.load(sys.stdin), sys.argv[1], sys.argv[2]), sys.stdout)
