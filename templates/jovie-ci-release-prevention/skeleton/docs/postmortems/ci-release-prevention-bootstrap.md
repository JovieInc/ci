# Postmortem: CI incident metadata inheritance

The historical template could claim prevention from hard-coded boolean fixtures
without installing or exercising a real consumer. The bootstrap now installs
actual files into a fresh project; tests execute that verifier and deliberately
remove or corrupt evidence, use floating pins, and attempt unsafe destinations.

This guards scaffold installation and metadata shape only. It does not claim to
reproduce incidents or prove that their referenced regressions detect recurrence.
