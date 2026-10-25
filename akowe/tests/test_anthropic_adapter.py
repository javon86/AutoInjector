"""AnthropicAdapter unit tests (BF-18) with a stubbed `anthropic` SDK module: no network, no real SDK needed."""
from __future__ import annotations

import json
import sys
import types

import pytest

from bookforge.errors import BookforgeError
from bookforge.providers import AnthropicAdapter

SLOT = {"model": "claude-test", "max_output_tokens": 100, "effort": "high"}


class _APIError(Exception):
    pass


class _APIStatusError(_APIError):
    def __init__(self, message="", status_code=500):
        super().__init__(message)
        self.message, self.status_code = message, status_code


def make_sdk(behaviour, *, with_errors=True, client_kwargs_ok=True):
    """A minimal stand-in for the anthropic package. `behaviour(kwargs)` returns a response or raises."""
    sdk = types.ModuleType("anthropic")
    calls = []
    if with_errors:
        sdk.APIError = _APIError
        sdk.APIStatusError = _APIStatusError
        for name, base in (("RateLimitError", _APIStatusError), ("AuthenticationError", _APIStatusError),
                           ("PermissionDeniedError", _APIStatusError), ("BadRequestError", _APIStatusError),
                           ("APIConnectionError", _APIError)):
            setattr(sdk, name, type(name, (base,), {}))
        sdk.APITimeoutError = type("APITimeoutError", (sdk.APIConnectionError,), {})

    class Stream:
        def __init__(self, kwargs):
            self.kwargs = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_final_message(self):
            return behaviour(self.kwargs)

    class Messages:
        def stream(self, **kwargs):
            calls.append(kwargs)
            return Stream(kwargs)

    class Client:
        def __init__(self, **kwargs):
            if not client_kwargs_ok:
                raise TypeError("__init__() got an unexpected keyword argument 'max_retries'")
            self.kwargs = kwargs
            self.beta = types.SimpleNamespace(messages=Messages())

    sdk.Anthropic = Client
    sdk.calls = calls
    return sdk


def response(text, stop="end_turn", usage=(12, 34)):
    return types.SimpleNamespace(stop_reason=stop, model="claude-test", _request_id="req_1",
                                 content=[types.SimpleNamespace(type="text", text=text)],
                                 usage=types.SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1]))


@pytest.fixture
def install(monkeypatch):
    def _install(sdk):
        monkeypatch.setitem(sys.modules, "anthropic", sdk)
        return sdk
    return _install


def submit(api_key="sk-test"):
    return AnthropicAdapter(api_key).submit(SLOT, "system", "user", {"type": "object"})


def test_success_returns_json_and_usage(install):
    sdk = install(make_sdk(lambda kw: response(json.dumps({"text": "hello"}))))
    data, usage = submit()
    assert data == {"text": "hello"}
    assert usage == {"input_tokens": 12, "output_tokens": 34, "model": "claude-test", "provider_request_id": "req_1"}
    sent = sdk.calls[0]
    assert sent["model"] == "claude-test" and sent["max_tokens"] == 100
    assert sent["output_config"]["format"] == {"type": "json_schema", "schema": {"type": "object"}}


def test_missing_sdk_is_capability_unavailable(monkeypatch):
    monkeypatch.setitem(sys.modules, "anthropic", None)  # import fails
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == "CAPABILITY_UNAVAILABLE" and "pip install" in exc.value.errors[0]["message"]


def test_old_sdk_rejecting_new_arguments_gets_an_upgrade_message(install):
    def old(kw):
        raise TypeError("stream() got an unexpected keyword argument 'fallbacks'")
    install(make_sdk(old))
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == "CAPABILITY_UNAVAILABLE"
    assert "--upgrade anthropic" in exc.value.errors[0]["message"]


def test_old_sdk_client_constructor(install):
    install(make_sdk(lambda kw: response("{}"), client_kwargs_ok=False))
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == "CAPABILITY_UNAVAILABLE" and "too old" in exc.value.errors[0]["message"]


@pytest.mark.parametrize("name,code", [("RateLimitError", "RATE_LIMITED"), ("APITimeoutError", "TIMEOUT"),
                                       ("APIConnectionError", "UPSTREAM_UNAVAILABLE"),
                                       ("AuthenticationError", "CAPABILITY_UNAVAILABLE"),
                                       ("PermissionDeniedError", "CAPABILITY_UNAVAILABLE"),
                                       ("BadRequestError", "INVALID_INPUT")])
def test_sdk_errors_are_classified(install, name, code):
    holder = {}

    def fail(kw):
        raise getattr(holder["sdk"], name)("boom")
    holder["sdk"] = install(make_sdk(fail))
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == code


@pytest.mark.parametrize("status,code", [(503, "UPSTREAM_UNAVAILABLE"), (418, "INTERNAL_ERROR")])
def test_status_errors(install, status, code):
    def fail(kw):
        raise _APIStatusError("x", status_code=status)
    install(make_sdk(fail))
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == code


def test_unknown_sdk_error_and_sdk_without_error_classes(install):
    def fail(kw):
        raise RuntimeError("socket exploded")
    install(make_sdk(fail, with_errors=False))  # an SDK lacking the error classes must not crash the except
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == "INTERNAL_ERROR" and "RuntimeError: socket exploded" in exc.value.errors[0]["message"]


@pytest.mark.parametrize("resp,code", [(response("{}", stop="refusal"), "CAPABILITY_UNAVAILABLE"),
                                       (response("{}", stop="max_tokens"), "CONTEXT_TOO_LARGE"),
                                       (response("not json"), "INTERNAL_ERROR"),
                                       (response("[1, 2]"), "INTERNAL_ERROR")])
def test_bad_responses(install, resp, code):
    install(make_sdk(lambda kw: resp))
    with pytest.raises(BookforgeError) as exc:
        submit()
    assert exc.value.code == code
