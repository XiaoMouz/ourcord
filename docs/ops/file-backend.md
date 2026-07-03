# Autonomous File Backend Smoke

This smoke verifies the Phase-2 autonomous file backend loop:

1. Run the reference backend:
   ```bash
   (cd filebackend && go run ./cmd/ourcord-filebackend --addr :8090 --data-dir /tmp/ourcord-filebackend)
   ```
2. Register `http://127.0.0.1:8090` through `POST /api/backends`.
3. Initiate an upload with `POST /api/rooms/:roomId/files`.
4. `PUT` the bytes to the returned `upload_url`.
5. Publish the file with `POST /api/rooms/:roomId/files/:fileId/complete` and the returned `upload_token`.
6. Verify `GET /api/rooms/:roomId/files` includes the file and `GET /api/rooms/:roomId/files/:fileId/download` returns the backend URL.

Permission/state checks to include in every manual smoke:

- A non-member cannot list files, initiate uploads, or download files for the room.
- A pending external upload is not returned by `GET /api/rooms/:roomId/files`.
- A pending external upload returns 409 from the service download endpoint.
- Only the uploader can complete an external upload; bad tokens return 403 and double-complete returns 409.
- The backend file exists on disk before `complete`, and the service row becomes `uploaded` with `actual_size_bytes` only after `complete`.
- For R2 uploads, only the uploader can `PUT` to `/upload`; other members and non-members are rejected before bytes are stored.
- Room members can download completed files; non-members cannot.

Backend health is checked with:

```bash
POST /api/backends/:backendId/check
```

The service also probes active backends from the scheduled maintenance handler.
Recently unhealthy backends are skipped by the resolver for one hour, so new
uploads fall through to the next tier in the fixed chain:

```text
personal backend -> shared backend -> lobby backend -> R2
```
