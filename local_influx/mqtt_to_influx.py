from __future__ import annotations

import json
import signal
import sys
from threading import Event

import paho.mqtt.client as mqtt

from .config import get_settings
from .influx_client import build_line_protocol, ensure_database, write_line_protocol


stop_event = Event()


def main() -> int:
    settings = get_settings()
    ensure_database(settings)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="memco-local-influx-bridge")

    def on_connect(client: mqtt.Client, _userdata, _flags, reason_code, _properties) -> None:
        if reason_code != 0:
            print(f"[mqtt-influx] connect failed: {reason_code}", file=sys.stderr)
            return
        client.subscribe(settings.mqtt_topic, qos=1)
        print(f"[mqtt-influx] subscribed to {settings.mqtt_topic}")

    def on_message(_client: mqtt.Client, _userdata, message: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("payload must be a JSON object")

            line_protocol = build_line_protocol(payload, message.topic, settings)
            if not line_protocol:
                print(f"[mqtt-influx] skipped payload without machine or voltage fields on {message.topic}")
                return

            write_line_protocol(settings, line_protocol)
            print(f"[mqtt-influx] wrote {message.topic}: {line_protocol}")
        except Exception as error:
            print(f"[mqtt-influx] failed to process {message.topic}: {error}", file=sys.stderr)

    def shutdown(_signum, _frame) -> None:
        stop_event.set()
        client.disconnect()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(settings.mqtt_broker_host, settings.mqtt_broker_port, keepalive=60)
    client.loop_start()

    print(
        "[mqtt-influx] bridge running "
        f"mqtt={settings.mqtt_broker_host}:{settings.mqtt_broker_port} "
        f"influx={settings.influxdb_url}/{settings.influxdb_database}"
    )
    stop_event.wait()
    client.loop_stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
