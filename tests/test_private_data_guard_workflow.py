import os
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


if __name__ == "__main__":
    unittest.main()
