import inspect
import json
import re
import sys

import soundfile as sf
from kokoro_onnx import Kokoro
from kokoro_onnx.config import EspeakConfig

model_path, voices_path, text, voice, speed, output_path, library_path, data_path = sys.argv[1:9]
lang = sys.argv[9] if len(sys.argv) > 9 else ""
model = Kokoro(model_path, voices_path, EspeakConfig(lib_path=library_path, data_path=data_path))
kwargs = {"voice": voice, "speed": float(speed)}
if lang and "lang" in inspect.signature(model.create).parameters:
    kwargs["lang"] = lang


def synthesize(value):
    try:
        return model.create(value, **kwargs)
    except IndexError as error:
        if not re.search(r"index \d+ is out of bounds for axis 0 with size 510", str(error), re.I) or len(value) < 2:
            raise
        midpoint = len(value) // 2
        boundaries = [index + 1 for index, char in enumerate(value) if (char in ".!?\n" or char.isspace()) and 0 < index < len(value) - 1]
        split = min(boundaries, key=lambda index: abs(index - midpoint)) if boundaries else midpoint
        left, left_rate = synthesize(value[:split])
        right, right_rate = synthesize(value[split:])
        if left_rate != right_rate:
            raise RuntimeError("Kokoro returned inconsistent sample rates")
        return list(left) + list(right), left_rate


samples, sample_rate = synthesize(text)
sf.write(output_path, samples, sample_rate)
print(json.dumps({"output": output_path, "sample_rate": sample_rate, "duration_seconds": round(len(samples) / sample_rate, 3)}))
