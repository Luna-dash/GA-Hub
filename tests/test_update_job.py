"""Safety policy for an updater in a scheduler-owned Windows Job."""
import pytest
from server.services import update_job


def test_unrestricted_scheduler_job_is_independent(monkeypatch):
    monkeypatch.setattr(update_job, "current_job_flags", lambda: 0)
    monkeypatch.setattr(update_job, "desktop_job_memberships", lambda: [False])
    assert update_job.safe_scheduler_job()


@pytest.mark.parametrize("flags", [0x2000, 0x100, 0x800, 0x4])
def test_limited_job_is_rejected(monkeypatch, flags):
    monkeypatch.setattr(update_job, "current_job_flags", lambda: flags)
    monkeypatch.setattr(update_job, "desktop_job_memberships", lambda: [False])
    assert not update_job.safe_scheduler_job()


def test_desktop_owned_job_is_rejected(monkeypatch):
    monkeypatch.setattr(update_job, "current_job_flags", lambda: 0)
    monkeypatch.setattr(update_job, "desktop_job_memberships", lambda: [False, True])
    assert not update_job.safe_scheduler_job()


def test_unknown_job_is_rejected(monkeypatch):
    monkeypatch.setattr(update_job, "current_job_flags", lambda: 0)
    def unknown():
        raise OSError("Cannot inspect desktop Job")
    monkeypatch.setattr(update_job, "desktop_job_memberships", unknown)
    with pytest.raises(OSError):
        update_job.safe_scheduler_job()
