"""Errors whose message is safe and useful to show in the desktop UI as-is."""


class UserFacingError(RuntimeError):
    """Raised with a message that contains no credentials or remote response bodies."""


class Cancelled(UserFacingError):
    """The user cancelled this video's review."""

    def __init__(self, message: str = '已取消'):
        super().__init__(message)
