"""Every ``bus.publish`` topic must be registered in server/event_topics.py.

A static scan keeps the topic vocabulary from drifting (2026-09 review:
~70 inline topic strings, "chat:reset" published in three separate places
with no single source). Modeled on test_env_registry. Subscribe-side prefix
filters and the frontend's own topic lists are wire contracts, not registry
members, and tests deliberately keep string literals as contract locks.
"""
from __future__ import annotations

import re
from pathlib import Path

from server import event_topics

ROOT = Path(__file__).resolve().parents[1]

# Match every ``.publish(`` variant (``bus.publish``/``self.publish``/…), not
# just the bare-bus spelling: wrapper callers build topics too.
PUBLISH_RE = re.compile(r'\.publish\(\s*(f?)"([^"]+)"')


def _registry_values() -> list[str]:
    return [
        value
        for name, value in vars(event_topics).items()
        if name.isupper() and isinstance(value, str)
    ]


def _publish_sites():
    """Yield (path, lineno, is_fstring, literal) for every .publish site.

    Matching runs over whole-file text, not per-line: `.publish(` followed
    by a topic literal on the next line is exactly the shape a drift would
    take (routes/sessions.py's multiline bus.publish calls predate this).
    """
    for path in sorted((ROOT / "server").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for match in PUBLISH_RE.finditer(text):
            lineno = text.count("\n", 0, match.start()) + 1
            yield path, lineno, match.group(1) == "f", match.group(2)


def test_registry_has_no_duplicate_values() -> None:
    values = _registry_values()
    assert len(values) == len(set(values))


def test_every_publish_topic_is_registered() -> None:
    registered = set(_registry_values())
    families = event_topics.DYNAMIC_FAMILIES
    offenders: list[str] = []
    for path, lineno, is_fstring, literal in _publish_sites():
        if is_fstring:
            static = literal.split("{", 1)[0]
            if not any(static.startswith(family) for family in families):
                offenders.append(f"{path.relative_to(ROOT)}:{lineno}: {literal}")
        elif literal not in registered:
            offenders.append(f"{path.relative_to(ROOT)}:{lineno}: {literal}")
    assert offenders == []


def test_registry_has_no_orphans() -> None:
    """Every registered topic constant is referenced by its name.

    The wire value does NOT count as a reference: a publisher writing
    ``"conductor:request_outcome"`` instead of the constant is precisely the
    drift this registry exists to stop, so matching on the value would
    whitelist it. Dynamic ``"conductor:" + kind`` topics are exempt because
    the constant is not what builds them.
    """
    other_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (ROOT / "server").rglob("*.py")
        if path.name != "event_topics.py"
    )
    orphans = [
        name
        for name, value in vars(event_topics).items()
        if name.isupper()
        and isinstance(value, str)
        and name not in other_text
    ]
    assert orphans == []
