#!/usr/bin/env python3
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-simulator-resources.py")


class CheckSimulatorResourcesArgumentTests(unittest.TestCase):
    def test_requires_exactly_two_expected_limits(self):
        for arguments in ([], ["4"], ["4", "536870912", "extra"]):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), *arguments],
                    input="{}",
                    capture_output=True,
                    check=False,
                    text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("usage:", result.stderr)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
