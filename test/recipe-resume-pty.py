"""Offline Pi resume smoke driver. Own a real PTY; never send model prompts."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

binary, report, flow, *args = sys.argv[1:]
pid, terminal = pty.fork()
if pid == 0:
    # Test-selected executable with an argv array: deliberately no shell or interpolation.
    os.execv(binary, [binary, *args])  # noqa: S606

output = bytearray()
phase = "pick" if flow == "picker" else "initial"
deadline = time.monotonic() + 40
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([terminal], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(terminal, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            output.extend(chunk)
        if phase == "pick" and b"resume-smoke-source" in output:
            os.write(terminal, b"\r")
            phase = "done"
        elif phase == "initial" and os.path.exists(report):
            # Wait for Pi to finish session_start and install its editor handler.
            time.sleep(0.3)
            os.write(terminal, b"/resume\r")
            output.clear()
            phase = "switch"
        elif phase == "switch" and b"Resume Session" in output and b"resume-smoke-target" in output:
            os.write(terminal, b"resume-smoke-target\r")
            phase = "done"
        exited, result = os.waitpid(pid, os.WNOHANG)
        if exited:
            status = os.waitstatus_to_exitcode(result)
            break
    if status is None:
        raise TimeoutError("Pi resume PTY did not exit; phase=" + phase + "\n" + output[-16000:].decode("utf-8", "replace"))
    print(json.dumps({"status": status, "phase": phase, "output": output[-16000:].decode("utf-8", "replace")}))
finally:
    if status is None:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
