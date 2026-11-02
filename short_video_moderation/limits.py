"""Request limits shared by every video in this process (threads and asyncio loops alike)."""
from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager, contextmanager


class Limiter:
    """A resizable counting limit usable from worker threads and from any event loop."""

    def __init__(self, limit: int):
        self._limit = max(1, int(limit))
        self._used = 0
        self._cond = threading.Condition()

    @property
    def limit(self) -> int:
        return self._limit

    def set_limit(self, limit: int) -> None:
        with self._cond:
            self._limit = max(1, int(limit))
            self._cond.notify_all()

    def try_acquire(self) -> bool:
        with self._cond:
            if self._used < self._limit:
                self._used += 1
                return True
            return False

    def acquire(self) -> None:
        with self._cond:
            while self._used >= self._limit:
                self._cond.wait()
            self._used += 1

    def release(self) -> None:
        with self._cond:
            self._used -= 1
            self._cond.notify_all()

    @contextmanager
    def slot(self):
        self.acquire()
        try:
            yield
        finally:
            self.release()

    @asynccontextmanager
    async def async_slot(self):
        # Polling keeps every job's event loop independent; the wait is short and cheap.
        delay = 0.01
        while not self.try_acquire():
            await asyncio.sleep(delay)
            delay = min(0.2, delay * 1.5)
        try:
            yield
        finally:
            self.release()


# Process-wide limits, sized from the desktop settings at the start of every job.
ASR_REQUESTS = Limiter(5)
MODEL_REQUESTS = {'jev': Limiter(8), 'openai': Limiter(8)}
