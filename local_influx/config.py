from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _int_env(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None or raw_value == "":
        return default
    return int(raw_value)


@dataclass(frozen=True)
class Settings:
    mqtt_broker_host: str
    mqtt_broker_port: int
    mqtt_topic: str
    mqtt_publish_topic: str
    influxdb_url: str
    influxdb_database: str
    influxdb_token: str
    influxdb_measurement: str
    python_api_host: str
    python_api_port: int


def get_settings() -> Settings:
    _load_env_file(Path(__file__).with_name(".env"))

    return Settings(
        mqtt_broker_host=os.getenv("MQTT_BROKER_HOST", "localhost"),
        mqtt_broker_port=_int_env("MQTT_BROKER_PORT", 1883),
        mqtt_topic=os.getenv("MQTT_TOPIC", "machine/data/#"),
        mqtt_publish_topic=os.getenv("MQTT_PUBLISH_TOPIC", "machine/data/3"),
        influxdb_url=os.getenv("INFLUXDB_URL", "http://localhost:8181").rstrip("/"),
        influxdb_database=os.getenv("INFLUXDB_DATABASE", "memco_iot"),
        influxdb_token=os.getenv(
            "INFLUXDB_TOKEN",
            "apiv3_local_memco_dev_token_change_me_1234567890",
        ),
        influxdb_measurement=os.getenv("INFLUXDB_MEASUREMENT", "machine_voltage"),
        python_api_host=os.getenv("PYTHON_API_HOST", "0.0.0.0"),
        python_api_port=_int_env("PYTHON_API_PORT", 8001),
    )
