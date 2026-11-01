CREATE TABLE IF NOT EXISTS sjsu_parking.parking_installations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at_utc BIGINT NOT NULL,
  revoked_at_utc BIGINT NULL
);

CREATE TABLE IF NOT EXISTS sjsu_parking.parking_enrollment_codes (
  code_hash CHAR(64) NOT NULL PRIMARY KEY,
  expires_at_utc BIGINT NOT NULL,
  redeemed_at_utc BIGINT NULL,
  installation_id CHAR(36) NULL,
  CONSTRAINT fk_parking_enrollment_installation FOREIGN KEY (installation_id)
    REFERENCES sjsu_parking.parking_installations(id)
);

CREATE TABLE IF NOT EXISTS sjsu_parking.parking_visit_summaries (
  client_visit_id CHAR(36) NOT NULL PRIMARY KEY,
  installation_id CHAR(36) NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc BIGINT NOT NULL,
  KEY parking_visit_installation (installation_id),
  CONSTRAINT fk_parking_visit_installation FOREIGN KEY (installation_id)
    REFERENCES sjsu_parking.parking_installations(id)
);

CREATE TABLE IF NOT EXISTS sjsu_parking.parking_crossing_events (
  client_event_id CHAR(36) NOT NULL PRIMARY KEY,
  installation_id CHAR(36) NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc BIGINT NOT NULL,
  KEY parking_crossing_installation (installation_id),
  CONSTRAINT fk_parking_crossing_installation FOREIGN KEY (installation_id)
    REFERENCES sjsu_parking.parking_installations(id)
);
