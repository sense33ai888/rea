"""Bounded LLDB companion; targets and paths come from operator configuration."""
import json
import os
from pathlib import Path
import signal
import subprocess
import lldb


def require_identity(reader, pid, expected):
    result = subprocess.run([reader, "--identities", str(pid)], check=True,
                            capture_output=True, text=True, timeout=10)
    rows = json.loads(result.stdout)["results"]
    if (len(rows) != 1 or rows[0].get("state") != "readable"
            or rows[0].get("pid") != pid or rows[0].get("identity") != expected):
        raise RuntimeError("Target lifetime changed or is unknown; refusing attach/resume")


def collect(process, frame, probe):
    options = lldb.SBExpressionOptions()
    options.SetLanguage(lldb.eLanguageTypeObjC_plus_plus)
    options.SetIgnoreBreakpoints(True)
    options.SetTrapExceptions(False)
    options.SetTimeoutInMicroSeconds(15000000)
    options.SetPrefix('extern "C" void *dlopen(const char *, int);\n'
                      'extern "C" void *dlsym(void *, const char *);\n')
    expression = ('({ void *h = dlopen(' + json.dumps(probe) + ', 2); '
                  'void *f = h ? dlsym(h, "matrix_capture") : (void *)0; '
                  'f ? ((const char *(*)())f)() : (const char *)0; })')
    value = frame.EvaluateExpression(expression, options)
    if value.GetError().Fail():
        raise RuntimeError(str(value.GetError()))
    pointer = value.GetValueAsUnsigned()
    if not pointer:
        raise RuntimeError("Probe load failed; check the debug copy's library validation")
    try:
        error = lldb.SBError()
        raw = process.ReadCStringFromMemory(pointer, 16 * 1024 * 1024, error)
        if error.Fail():
            raise RuntimeError(str(error))
        document = json.loads(raw)
        if "error" in document:
            raise RuntimeError(document["error"] + ": " + document.get("reason", ""))
        return document
    finally:
        frame.EvaluateExpression('(void)free((void *)' + str(pointer) + ')', options)


def capture_attached(debugger, executable, pid, identity, reader, output):
    """No launch or target termination. Publish only after detach and resume."""
    output_path = Path(output)
    if not output_path.is_absolute() or output_path.exists():
        raise RuntimeError("Capture output must be a new absolute path")
    require_identity(reader, pid, identity)
    target = debugger.CreateTarget(executable)
    error = lldb.SBError()
    process = target.AttachToProcessWithID(debugger.GetListener(), pid, error)
    if error.Fail():
        raise RuntimeError("Attach failed: " + str(error))
    try:
        require_identity(reader, pid, identity)
        threads = [thread for thread in process
                   if thread.GetQueueName() == "com.apple.main-thread"]
        if len(threads) != 1:
            raise RuntimeError("Cannot uniquely identify the AppKit main thread")
        frame = threads[0].GetFrameAtIndex(0)
        probe = str(Path(__file__).parent / "build/native-hierarchy-probe.dylib")
        document = collect(process, frame, probe)
        document.update(process_id=pid, process_identity=identity, executable=executable)
    finally:
        detached = process.Detach(False)
        if detached.Fail():
            raise RuntimeError("Detach failed; target cleanup is unresolved: " + str(detached))
        # A successful detach can leave a pending SIGSTOP. Never signal a reused PID.
        require_identity(reader, pid, identity)
        os.kill(pid, signal.SIGCONT)
    with output_path.open("x", encoding="utf-8") as stream:
        json.dump(document, stream, indent=2, allow_nan=False)
