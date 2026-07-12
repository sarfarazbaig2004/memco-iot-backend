from __future__ import annotations

import argparse
import json
from pathlib import Path

import paho.mqtt.client as mqtt

from .config import get_settings


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish a JSON telemetry payload to local MQTT.")
    parser.add_argument("--payload", default="payload.json", help="Path to the JSON payload file.")
    parser.add_argument("--topic", default=None, help="MQTT topic override.")
    args = parser.parse_args()

    settings = get_settings()
    payload_path = Path(args.payload)
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    topic = args.topic or settings.mqtt_publish_topic

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="memco-local-sample-publisher")
    client.connect(settings.mqtt_broker_host, settings.mqtt_broker_port, keepalive=30)
    client.loop_start()
    result = client.publish(topic, json.dumps(payload), qos=1)
    result.wait_for_publish()
    client.loop_stop()
    client.disconnect()

    if result.rc != mqtt.MQTT_ERR_SUCCESS:
        raise RuntimeError(f"MQTT publish failed with result code {result.rc}")

    print(f"Published {payload_path} to {topic}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
