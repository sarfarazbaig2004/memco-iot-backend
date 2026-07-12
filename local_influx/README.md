# Local InfluxDB 3 MQTT Test Path

This folder is for the first local-machine proof of concept:

1. Run InfluxDB 3 Core locally.
2. Read JSON payloads from MQTT and store voltage telemetry in InfluxDB.
3. Publish sample telemetry over MQTT.
4. Read machine voltage data through Python APIs.

## Setup

Install Docker Desktop, then create the local InfluxDB admin token file:

```sh
mkdir -p local_influx/secrets
cp local_influx/secrets/influxdb3-admin-token.example.json local_influx/secrets/influxdb3-admin-token.json
chmod 600 local_influx/secrets/influxdb3-admin-token.json
```

Start InfluxDB 3 Core and a local Mosquitto broker:

```sh
docker compose -f docker-compose.influx.yml up -d
```

Create a Python virtual environment:

```sh
python3 -m venv .venv-influx
source .venv-influx/bin/activate
pip install -r local_influx/requirements.txt
cp local_influx/.env.example local_influx/.env
```

Create the local database:

```sh
curl http://localhost:8181/api/v3/configure/database \
  --header "Authorization: Bearer apiv3_local_memco_dev_token_change_me_1234567890" \
  --json '{"db": "memco_iot"}'
```

## Run the MQTT to Influx bridge

```sh
source .venv-influx/bin/activate
python -m local_influx.mqtt_to_influx
```

## Publish sample telemetry

In another terminal:

```sh
source .venv-influx/bin/activate
python -m local_influx.publish_sample --payload payload.json
```

## Run the Python voltage API

```sh
source .venv-influx/bin/activate
uvicorn local_influx.api:app --host 0.0.0.0 --port 8001
```

Try:

```sh
curl "http://localhost:8001/health"
curl "http://localhost:8001/api/machines/3/voltage?limit=20"
curl "http://localhost:8001/api/machines/3/latest-voltage"
```
