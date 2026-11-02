"""Errors whose message is safe and useful to show in the desktop UI as-is."""


class UserFacingError(RuntimeError):
    """Raised with a message that contains no credentials or remote response bodies."""
