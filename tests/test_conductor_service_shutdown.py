from __future__ import annotations

import threading
import time
from unittest import mock

from server.services import conductor_service
from server.services.conductor_ext_timeout import TimeoutMonitor


class _StopRecorder:
    def __init__(self, *results: object) -> None:
        self.results = list(results or (True,))
        self.timeouts: list[float] = []

    def stop(self, timeout: float) -> object:
        self.timeouts.append(timeout)
        result = self.results.pop(0) if self.results else True
        if isinstance(result, BaseException):
            raise result
        return result


def _service(core: object | None, monitor: object | None):
    service = object.__new__(conductor_service.ConductorService)
    if core is not None:
        service.conductor = core
    if monitor is not None:
        service.timeout_monitor = monitor
    return service


def test_shutdown_helper_does_not_construct_unused_singleton(monkeypatch) -> None:
    instance = mock.Mock(side_effect=AssertionError("must not construct"))
    monkeypatch.setattr(conductor_service.ConductorService, "_instance", None)
    monkeypatch.setattr(
        conductor_service.ConductorService,
        "instance",
        instance,
    )

    assert conductor_service.shutdown_conductor_service(timeout=0.01) is True
    instance.assert_not_called()


def test_shutdown_stops_core_then_monitor_with_one_shared_deadline() -> None:
    order: list[str] = []

    class Core(_StopRecorder):
        def stop(self, timeout: float) -> object:
            order.append("core")
            time.sleep(0.02)
            return super().stop(timeout)

    class Monitor(_StopRecorder):
        def stop(self, timeout: float) -> object:
            order.append("monitor")
            return super().stop(timeout)

    core = Core(True)
    monitor = Monitor(True)
    service = _service(core, monitor)

    assert service.shutdown(timeout=0.1) is True
    assert order == ["core", "monitor"]
    assert 0.0 <= monitor.timeouts[0] < core.timeouts[0] <= 0.1


def test_successful_shutdown_is_cached_and_terminal() -> None:
    core = _StopRecorder(True)
    monitor = _StopRecorder(True)
    service = _service(core, monitor)

    assert service.shutdown(timeout=0.1) is True
    assert service.shutdown(timeout=0.1) is True

    assert len(core.timeouts) == 1
    assert len(monitor.timeouts) == 1
    assert service._closed is True


def test_concurrent_shutdown_has_one_cleanup_owner() -> None:
    entered = threading.Event()
    release = threading.Event()

    class BlockingCore(_StopRecorder):
        def stop(self, timeout: float) -> object:
            self.timeouts.append(timeout)
            entered.set()
            release.wait(0.5)
            return True

    core = BlockingCore(True)
    monitor = _StopRecorder(True)
    service = _service(core, monitor)
    owner_result: list[bool] = []
    owner = threading.Thread(
        target=lambda: owner_result.append(service.shutdown(timeout=0.5))
    )
    owner.start()
    assert entered.wait(0.5)

    assert service.shutdown(timeout=0.01) is False
    assert len(core.timeouts) == 1
    assert monitor.timeouts == []

    release.set()
    owner.join(0.5)
    assert owner_result == [True]
    assert len(core.timeouts) == 1
    assert len(monitor.timeouts) == 1


def test_core_exception_still_stops_monitor_and_later_retry_finishes() -> None:
    core = _StopRecorder(RuntimeError("boom"), True)
    monitor = _StopRecorder(True)
    service = _service(core, monitor)

    assert service.shutdown(timeout=0.1) is False
    assert len(core.timeouts) == 1
    assert len(monitor.timeouts) == 1

    assert service.shutdown(timeout=0.1) is True
    assert len(core.timeouts) == 2
    # A component already confirmed stopped is not repeated on retry.
    assert len(monitor.timeouts) == 1


def test_core_timeout_leaves_monitor_only_the_remaining_budget() -> None:
    class DeadlineCore(_StopRecorder):
        def stop(self, timeout: float) -> object:
            self.timeouts.append(timeout)
            time.sleep(timeout)
            return False

    core = DeadlineCore(False)
    monitor = _StopRecorder(True)
    service = _service(core, monitor)
    started = time.monotonic()

    assert service.shutdown(timeout=0.02) is False

    elapsed = time.monotonic() - started
    assert elapsed < 0.15
    assert len(monitor.timeouts) == 1
    # A few microseconds can elapse between the core's timed return and the
    # service sampling the shared monotonic deadline; keep the assertion
    # focused on the remaining-budget contract rather than float rounding.
    assert monitor.timeouts[0] <= 0.006


def test_timeout_monitor_retains_live_thread_for_later_reap() -> None:
    release = threading.Event()
    thread = threading.Thread(target=release.wait)
    thread.start()
    monitor = TimeoutMonitor(object(), check_interval=1.0)
    monitor._thread = thread

    try:
        assert monitor.stop(timeout=0.01) is False
        assert monitor._thread is thread

        release.set()
        assert monitor.stop(timeout=0.5) is True
        assert monitor._thread is None
    finally:
        release.set()
        thread.join(0.5)


def test_closed_service_cannot_restart_core() -> None:
    core = _StopRecorder(True)
    core.start = mock.Mock(return_value=True)
    service = _service(core, _StopRecorder(True))

    assert service.shutdown(timeout=0.1) is True

    try:
        service.ensure_started()
    except RuntimeError as exc:
        assert "closed" in str(exc)
    else:
        raise AssertionError("terminal shutdown must reject a restart")
    core.start.assert_not_called()
