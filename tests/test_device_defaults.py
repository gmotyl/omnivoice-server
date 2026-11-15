"""Per-platform defaults for OMNIVOICE_DEVICE and OMNIVOICE_STEPS (pure functions, no torch)."""

from server import resolve_device, resolve_steps


def test_device_defaults_to_cuda_when_available():
    assert resolve_device({}, cuda_available=True) == "cuda:0"


def test_device_defaults_to_cpu_without_cuda():
    assert resolve_device({}, cuda_available=False) == "cpu"


def test_device_never_auto_selects_mps():
    for cuda in (True, False):
        assert resolve_device({}, cuda_available=cuda) != "mps"


def test_explicit_device_wins():
    for value in ("cpu", "mps", "cuda:1"):
        for cuda in (True, False):
            assert resolve_device({"OMNIVOICE_DEVICE": value}, cuda_available=cuda) == value


def test_empty_device_env_treated_as_unset():
    assert resolve_device({"OMNIVOICE_DEVICE": ""}, cuda_available=True) == "cuda:0"
    assert resolve_device({"OMNIVOICE_DEVICE": ""}, cuda_available=False) == "cpu"


def test_steps_default_16_on_cuda():
    assert resolve_steps({}, "cuda:0") == 16
    assert resolve_steps({}, "cuda:1") == 16


def test_steps_default_8_on_cpu():
    assert resolve_steps({}, "cpu") == 8
    assert resolve_steps({}, "mps") == 8


def test_explicit_steps_win_on_any_device():
    for device in ("cuda:0", "cpu", "mps"):
        assert resolve_steps({"OMNIVOICE_STEPS": "12"}, device) == 12
