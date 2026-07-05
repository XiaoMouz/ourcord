-- Per-backend capability secret. The backend operator sets the same value on
-- `ourcord-filebackend --upload-secret`; the service uses it to sign
-- short-lived path+op-bound capabilities (?cap=<exp>.<sig>) into upload and
-- download URLs, so only URLs minted by the service work against the backend.
-- Empty = open backend (dev mode, no capability appended or enforced).

ALTER TABLE file_backends
  ADD COLUMN upload_secret TEXT NOT NULL DEFAULT '';
