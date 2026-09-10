"""Deployment must preserve the live service while preparing a candidate."""
import copy
import importlib.util
from pathlib import Path
import unittest

module_spec = importlib.util.spec_from_file_location(
    "prepare_cloud_run", Path(__file__).resolve().parents[1] / "scripts" / "prepare-cloud-run.py"
)
module = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(module)


def service_fixture():
    return {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": "baudoku", "namespace": "123", "resourceVersion": "42",
            "uid": "server-owned", "creationTimestamp": "server-owned",
            "labels": {"app": "baudoku"},
            "annotations": {
                "run.googleapis.com/ingress": "all",
                "run.googleapis.com/urls": "server-owned",
                "run.googleapis.com/ingress-status": "all",
                "run.googleapis.com/operation-id": "server-owned",
                "serving.knative.dev/creator": "creator",
                "serving.knative.dev/lastModifier": "modifier",
            },
        },
        "spec": {
            "template": {
                "metadata": {"name": "old", "labels": {"revision": "label"}, "annotations": {
                    "run.googleapis.com/sources": "source-overlay",
                    "run.googleapis.com/base-images": "base-image",
                    "autoscaling.knative.dev/maxScale": "3",
                }},
                "spec": {
                    "runtimeClassName": "source-runtime",
                    "serviceAccountName": "runtime@example.test",
                    "timeoutSeconds": 300, "containerConcurrency": 80,
                    "containers": [{
                        "image": "old-image", "command": ["old"], "args": ["old"],
                        "ports": [{"containerPort": 8080}],
                        "resources": {"limits": {"memory": "512Mi", "cpu": "1000m"}},
                        "startupProbe": {"tcpSocket": {"port": 8080}},
                        "env": [
                            {"name": "GEMINI_API_KEY", "valueFrom": {"secretKeyRef": {
                                "name": "gemini-key", "key": "latest"}}},
                            {"name": "FIREBASE_PROJECT_ID", "value": "project"},
                            {"name": "NODE_ENV", "value": "development"},
                        ],
                    }],
                },
            },
            "traffic": [{"latestRevision": True, "percent": 100}],
        },
        "status": {"traffic": [
            {"revisionName": "live-a", "percent": 60, "latestRevision": True},
            {"revisionName": "live-b", "percent": 40, "tag": "stable", "url": "https://stable"},
            {"revisionName": "debug", "percent": 0, "tag": "debug"},
            {"revisionName": "old-candidate", "percent": 0, "tag": "candidate"},
        ]},
    }


class DeploymentConfigTests(unittest.TestCase):
    def prepare(self, service=None):
        return module.prepare(service or service_fixture(), "repo/image@sha256:abc", "new-revision")

    def test_preserves_runtime_settings_and_secret_references(self):
        original = service_fixture()
        result = self.prepare(original)
        spec = result["spec"]["template"]["spec"]
        old_spec = original["spec"]["template"]["spec"]
        for key in ("serviceAccountName", "timeoutSeconds", "containerConcurrency"):
            self.assertEqual(spec[key], old_spec[key])
        container = spec["containers"][0]
        for key in ("ports", "resources", "startupProbe"):
            self.assertEqual(container[key], old_spec["containers"][0][key])
        self.assertEqual(container["env"][:2], old_spec["containers"][0]["env"][:2])
        self.assertEqual([item for item in container["env"] if item["name"] == "NODE_ENV"],
                         [{"name": "NODE_ENV", "value": "production"}])
        self.assertEqual(container["image"], "repo/image@sha256:abc")
        self.assertEqual(container["command"], ["node"])
        self.assertEqual(container["args"], ["dist/server.cjs"])

    def test_does_not_mutate_input(self):
        original = service_fixture()
        before = copy.deepcopy(original)
        result = self.prepare(original)
        result["spec"]["template"]["spec"]["containers"][0]["env"][0]["valueFrom"]["secretKeyRef"]["name"] = "changed"
        result["metadata"]["labels"]["app"] = "changed"
        self.assertEqual(original, before)

    def test_preserves_live_split_and_other_tags_and_replaces_candidate(self):
        traffic = self.prepare()["spec"]["traffic"]
        self.assertEqual(traffic, [
            {"revisionName": "live-a", "percent": 60},
            {"revisionName": "live-b", "percent": 40, "tag": "stable"},
            {"revisionName": "debug", "percent": 0, "tag": "debug"},
            {"revisionName": "new-revision", "percent": 0, "tag": "candidate"},
        ])
        self.assertEqual(sum(item["percent"] for item in traffic), 100)
        self.assertFalse(any("latestRevision" in item or "url" in item for item in traffic))

    def test_removes_old_candidate_tag_without_removing_its_live_traffic(self):
        original = service_fixture()
        original["status"]["traffic"] = [{"revisionName": "live", "percent": 100, "tag": "candidate"}]
        self.assertEqual(self.prepare(original)["spec"]["traffic"], [
            {"revisionName": "live", "percent": 100},
            {"revisionName": "new-revision", "percent": 0, "tag": "candidate"},
        ])

    def test_removes_overlay_and_server_owned_metadata_only(self):
        result = self.prepare()
        self.assertNotIn("status", result)
        self.assertNotIn("uid", result["metadata"])
        self.assertNotIn("creationTimestamp", result["metadata"])
        self.assertEqual(result["metadata"]["resourceVersion"], "42")
        self.assertEqual(result["metadata"]["annotations"], {"run.googleapis.com/ingress": "all"})
        template = result["spec"]["template"]
        self.assertEqual(template["metadata"]["name"], "new-revision")
        self.assertEqual(template["metadata"]["annotations"], {"autoscaling.knative.dev/maxScale": "3"})
        self.assertEqual(template["metadata"]["labels"], {"revision": "label"})
        self.assertNotIn("runtimeClassName", template["spec"])

    def test_rejects_multi_container_service(self):
        original = service_fixture()
        original["spec"]["template"]["spec"]["containers"].append({"image": "sidecar"})
        with self.assertRaises(ValueError):
            self.prepare(original)

    def test_rejects_invalid_traffic_totals(self):
        for percent in (0, 99, 101):
            with self.subTest(percent=percent):
                original = service_fixture()
                original["status"]["traffic"] = [{"revisionName": "live", "percent": percent}]
                with self.assertRaises(ValueError):
                    self.prepare(original)

    def test_rejects_live_traffic_without_concrete_revision(self):
        for target in ({"latestRevision": True, "percent": 100},
                       {"revisionName": "", "percent": 100}):
            with self.subTest(target=target):
                original = service_fixture()
                original["status"]["traffic"] = [target]
                with self.assertRaises(ValueError):
                    self.prepare(original)

    def test_rejects_invalid_percent_even_when_total_is_100(self):
        for percents in ((-1, 101), (50.5, 49.5), ("100", 0)):
            with self.subTest(percents=percents):
                original = service_fixture()
                original["status"]["traffic"] = [
                    {"revisionName": "live-a", "percent": percents[0]},
                    {"revisionName": "live-b", "percent": percents[1]},
                ]
                with self.assertRaises(ValueError):
                    self.prepare(original)


if __name__ == "__main__":
    unittest.main()
