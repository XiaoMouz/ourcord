# OurCord Reference File Backend

Small self-hosted HTTP file server for the autonomous storage chain.

```bash
cd filebackend
go run ./cmd/ourcord-filebackend --addr :8090 --data-dir ./data
```

Register `http://host:8090` with the service `/api/backends` endpoint. The
service returns direct `PUT /files/...` URLs and later verifies uploads with
`HEAD /files/...` before publishing file metadata.

This reference server has no account system. Put it behind your own TLS,
firewall, or reverse proxy before exposing it to other users.
