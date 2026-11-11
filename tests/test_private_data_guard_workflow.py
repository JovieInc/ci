import os
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / ".github/workflows/private-data-guard.yml").read_text())
RUN = next(s for s in WORKFLOW["jobs"]["guard"]["steps"] if s.get("name") == "Scan for private data")["run"]
SCRIPT = RUN.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
ZERO = "0" * 40


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class PrivateDataGuard(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.repo = Path(t.name)
        git(self.repo, "init", "-q")
        (self.repo / "README.md").write_text("hello\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "one")
        self.base = git(self.repo, "rev-parse", "HEAD")

    def run_guard(self, files, extra_env=None):
        for name, body in files.items():
            p = self.repo / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "two")
        env = {**os.environ, "EVENT_NAME": "pull_request", "PR_BASE_SHA": self.base,
               "HEAD_SHA": git(self.repo, "rev-parse", "HEAD"), "FAIL_ON_FINDINGS": "true", **(extra_env or {})}
        return subprocess.run(["python3", "-c", SCRIPT], cwd=self.repo, env=env, capture_output=True, text=True)

    def test_clean_change_passes(self):
        self.assertEqual(self.run_guard({"src/a.ts": "export const a = 1;\n"}).returncode, 0)

    def test_env_file_fails_but_example_passes(self):
        self.assertEqual(self.run_guard({".env.example": "A=1\n"}).returncode, 0)
        r = self.run_guard({"apps/x/.env.production": "A=1\n"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("env-file", r.stdout)

    def test_internal_hostname_fails_without_echoing_value(self):
        r = self.run_guard({"docs/a.md": "see memory.timwhite.co for details\n"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("internal-hostname", r.stdout)
        self.assertNotIn("memory.timwhite.co", r.stdout)

    def test_allowlist_exempts_path(self):
        r = self.run_guard({".private-data-allowlist": "^docs/a\\.md$\n", "docs/a.md": "x.timwhite.co\n"})
        self.assertEqual(r.returncode, 0)

    def test_shadow_mode_reports_but_passes(self):
        r = self.run_guard({"keys/a.pem": "x\n"}, {"FAIL_ON_FINDINGS": "false"})
        self.assertEqual(r.returncode, 0)
        self.assertIn("key-or-cert-file", r.stdout)

class EndpointCheckout(unittest.TestCase):
    def setUp(self):
        t = tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.root = Path(t.name)
        self.origin = self.root / "origin"
        self.origin.mkdir()
        git(self.origin, "init", "-q", "-b", "main")
        # This unchanged legacy fixture distinguishes a correct endpoint diff
        # from the conservative whole-tree fallback.
        self.private_value = ".".join(str(n) for n in [192, 168, 4, 2])
        (self.origin / "legacy.txt").write_text(self.private_value + "\n")
        git(self.origin, "add", "-A")
        git(self.origin, "commit", "-q", "-m", "base")
        self.base = git(self.origin, "rev-parse", "HEAD")
        (self.origin / "new.txt").write_text("public change\n")
        git(self.origin, "add", "-A")
        git(self.origin, "commit", "-q", "-m", "head")
        self.head = git(self.origin, "rev-parse", "HEAD")
        self.clone = self.root / "clone"
        git(self.root, "clone", "--quiet", "--depth=1", "--no-tags",
            self.origin.as_uri(), str(self.clone))
        self.assertNotEqual(subprocess.run(
            ["git", "cat-file", "-e", self.base + "^{commit}"], cwd=self.clone,
            capture_output=True).returncode, 0)
        self.trace = self.root / "fetch.jsonl"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        wrapper = self.bin / "git"
        wrapper.write_text("#!/usr/bin/env python3\n" +
            "import json, os, subprocess, sys\n" +
            "if sys.argv[1:2] == ['fetch']:\n" +
            "    with open(os.environ['FETCH_TRACE'], 'a') as f:\n" +
            "        f.write(json.dumps({'args':sys.argv[1:], 'config':{k:v for k,v in os.environ.items() if k.startswith('GIT_CONFIG_')}}) + '\\n')\n" +
            "sys.exit(subprocess.run([os.environ['REAL_GIT'], *sys.argv[1:]]).returncode)\n")
        wrapper.chmod(0o755)

    def run_workflow(self, event="pull_request", base=None, full=False, token=True, head=None):
        env = {**os.environ, "EVENT_NAME": event, "PR_BASE_SHA": ZERO,
               "MERGE_GROUP_BASE_SHA": ZERO, "PUSH_BEFORE": ZERO,
               "HEAD_SHA": head or self.head, "FULL_TREE": "true" if full else "false",
               "FAIL_ON_FINDINGS": "true", "EXTRA_PATHS": "", "EXTRA_CONTENT": "",
               "GH_TOKEN": "fixture-read-token" if token else "",
               "GITHUB_SERVER_URL": "https://github.com", "REAL_GIT": shutil.which("git"),
               "FETCH_TRACE": str(self.trace), "PATH": str(self.bin) + os.pathsep + os.environ["PATH"]}
        key = {"pull_request": "PR_BASE_SHA", "push": "PUSH_BEFORE",
               "merge_group": "MERGE_GROUP_BASE_SHA"}.get(event)
        if key:
            env[key] = base or self.base
        prep = next((s for s in WORKFLOW["jobs"]["guard"]["steps"]
                     if s.get("name") == "Fetch exact comparison base"), None)
        if prep:
            result = subprocess.run(["bash", "-e", "-c", prep["run"]], cwd=self.clone,
                                    env=env, capture_output=True, text=True)
            if result.returncode:
                return result
        return subprocess.run(["bash", "-e", "-c", RUN], cwd=self.clone,
                              env=env, capture_output=True, text=True)

    def test_checkout_keeps_full_head_tree_but_does_not_fetch_history(self):
        checkout = WORKFLOW["jobs"]["guard"]["steps"][0]
        self.assertEqual(checkout["with"]["fetch-depth"], 1)
        self.assertFalse(checkout["with"]["persist-credentials"])
        self.assertNotIn("filter", checkout["with"])
        self.assertEqual(WORKFLOW["jobs"]["guard"]["timeout-minutes"], 10)

    def test_all_event_endpoints_fetch_only_missing_base_and_keep_head(self):
        for event in ["pull_request", "push", "merge_group"]:
            with self.subTest(event=event):
                if event != "pull_request":
                    shutil.rmtree(self.clone)
                    git(self.root, "clone", "--quiet", "--depth=1", "--no-tags",
                        self.origin.as_uri(), str(self.clone))
                if self.trace.exists():
                    self.trace.unlink()
                result = self.run_workflow(event)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("scanned change: 0 finding(s)", result.stdout)
                self.assertEqual(git(self.clone, "rev-parse", "HEAD"), self.head)
                fetches = [json.loads(line) for line in self.trace.read_text().splitlines()]
                self.assertEqual(len(fetches), 1)
                self.assertEqual(fetches[0]["args"],
                                 ["fetch", "--no-tags", "--depth=1", "origin", self.base])
                values = fetches[0]["config"]
                self.assertTrue(any(value.startswith("AUTHORIZATION: basic ")
                                    for key, value in values.items() if key.startswith("GIT_CONFIG_VALUE_")))
                self.assertNotIn("fixture-read-token", " ".join(fetches[0]["args"]))
                self.assertNotIn("extraheader", git(self.clone, "config", "--local", "--list").lower())
                self.trace.unlink()
                again = self.run_workflow(event)
                self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
                self.assertFalse(self.trace.exists(), "already-present base should not refetch")

    def test_anonymous_public_base_fetch_preserves_scan(self):
        result = self.run_workflow(token=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("scanned change", result.stdout)

    def test_new_private_content_still_fails_without_echoing_value(self):
        new_value = ".".join(str(n) for n in [192, 168, 7, 8])
        (self.origin / "new.txt").write_text(new_value + "\n")
        git(self.origin, "add", "-A")
        git(self.origin, "commit", "-q", "-m", "private addition")
        self.head = git(self.origin, "rev-parse", "HEAD")
        git(self.clone, "fetch", "--quiet", "--depth=1", "origin", self.head)
        git(self.clone, "checkout", "--quiet", "--detach", self.head)
        result = self.run_workflow()
        self.assertEqual(result.returncode, 1)
        self.assertIn("private-ip", result.stdout)
        self.assertIn("scanned change", result.stdout)
        self.assertNotIn(new_value, result.stdout + result.stderr)

    def test_unknown_and_zero_bases_keep_blocking_full_tree_fallback(self):
        for base in [ZERO, "unknown"]:
            with self.subTest(base=base):
                result = self.run_workflow(base=base)
                self.assertEqual(result.returncode, 1)
                self.assertIn("scanned tree", result.stdout)
                self.assertIn("private-ip", result.stdout)
                self.assertFalse(self.trace.exists())

    def test_failed_base_fetch_keeps_blocking_full_tree_fallback(self):
        git(self.clone, "remote", "set-url", "origin", (self.root / "missing").as_uri())
        result = self.run_workflow()
        self.assertEqual(result.returncode, 1)
        self.assertIn("scanned tree", result.stdout)
        self.assertIn("private-ip", result.stdout)
        self.assertEqual(git(self.clone, "rev-parse", "HEAD"), self.head)

    def test_explicit_full_tree_still_scans_unchanged_private_content(self):
        result = self.run_workflow(full=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("scanned tree", result.stdout)
        self.assertIn("private-ip", result.stdout)
        self.assertFalse(self.trace.exists())

    def test_wrong_checked_out_head_is_rejected_before_scanning(self):
        result = self.run_workflow(head=self.base)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("scanned change", result.stdout)
        self.assertNotIn("scanned tree", result.stdout)


if __name__ == "__main__":
    unittest.main()
