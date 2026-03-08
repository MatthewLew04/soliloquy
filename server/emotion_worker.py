"""
Emotion2vec Worker — Flask API for voice emotion recognition.

Loads the emotion2vec_plus_large model and exposes an HTTP endpoint
that accepts raw PCM audio and returns emotion predictions.

Run: source emotion_venv/bin/activate && python emotion_worker.py
"""

import os
import sys
import time
import tempfile
import json
import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify

app = Flask(__name__)

# ============================================================
# Load emotion2vec model (downloads on first run)
# ============================================================
print("Loading emotion2vec_plus_large model...")
load_start = time.time()

from funasr import AutoModel
model = AutoModel(model="iic/emotion2vec_plus_large")

load_time = time.time() - load_start
print(f"Model loaded in {load_time:.1f}s")

# Emotion labels from the model
EMOTION_LABELS = [
    "angry", "disgusted", "fearful", "happy",
    "neutral", "other", "sad", "surprised", "unknown"
]

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "model": "emotion2vec_plus_large"})

@app.route('/predict', methods=['POST'])
def predict():
    """
    Accepts raw PCM audio (16kHz, 16-bit, mono) and returns emotion prediction.
    
    Body: raw PCM bytes
    Query params:
      - sample_rate: int (default 16000)
    """
    start_time = time.time()

    # Get raw PCM audio from request body
    pcm_data = request.get_data()
    if len(pcm_data) < 320:  # Less than 10ms of audio
        return jsonify({"error": "audio too short", "min_bytes": 320}), 400

    sample_rate = int(request.args.get('sample_rate', 16000))

    # Convert raw PCM bytes to numpy array
    audio_np = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0

    # Save to temp WAV file (funasr needs a file path)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name
        sf.write(tmp_path, audio_np, sample_rate)

    try:
        # Run emotion prediction
        result = model.generate(
            tmp_path,
            granularity="utterance",
            extract_embedding=False
        )

        inference_time = time.time() - start_time

        # Parse result
        if result and len(result) > 0:
            scores = result[0].get('scores', [])
            labels = result[0].get('labels', EMOTION_LABELS)

            # Clean up bilingual labels (e.g. "生气/angry" → "angry")
            clean_labels = []
            for label in labels:
                if '/' in label:
                    clean_labels.append(label.split('/')[-1])
                elif label == '<unk>':
                    clean_labels.append('unknown')
                else:
                    clean_labels.append(label)
            labels = clean_labels

            if scores:
                # Find top emotion
                top_idx = int(np.argmax(scores))
                top_emotion = labels[top_idx] if top_idx < len(labels) else 'unknown'
                top_score = float(scores[top_idx])

                # Build all emotions dict
                emotions = {}
                for i, label in enumerate(labels):
                    if i < len(scores):
                        emotions[label] = round(float(scores[i]), 4)

                return jsonify({
                    "emotion": top_emotion,
                    "score": round(top_score, 4),
                    "all_emotions": emotions,
                    "inference_ms": round(inference_time * 1000, 1),
                    "audio_duration_ms": round(len(audio_np) / sample_rate * 1000, 1),
                })
            else:
                return jsonify({
                    "emotion": "unknown",
                    "score": 0,
                    "error": "no scores returned",
                    "inference_ms": round(inference_time * 1000, 1),
                })
        else:
            return jsonify({
                "emotion": "unknown",
                "score": 0,
                "error": "empty result",
                "inference_ms": round(inference_time * 1000, 1),
            })

    finally:
        os.unlink(tmp_path)


if __name__ == '__main__':
    print("")
    print("=== Emotion2vec Worker ===")
    print("  Endpoint: http://localhost:5050/predict")
    print("  Health:   http://localhost:5050/health")
    print("  Model:    emotion2vec_plus_large (~300M params)")
    print("")
    app.run(host='0.0.0.0', port=5050, debug=False)
