-- Preparing this schema does not start legacy resources' countdown.
ALTER TABLE resources ADD COLUMN expiration_policy_version INTEGER NOT NULL DEFAULT 0 CHECK(expiration_policy_version IN (0,1));
ALTER TABLE resources ADD COLUMN retention_seconds INTEGER DEFAULT 2592000 CHECK(retention_seconds IS NULL OR (retention_seconds > 0 AND retention_seconds <= 9007199254740991));
ALTER TABLE resources ADD COLUMN published_at INTEGER;
ALTER TABLE resources ADD COLUMN expires_at INTEGER CHECK(expires_at IS NULL OR (expires_at > 0 AND expires_at <= 9007199254740991));
ALTER TABLE resources ADD COLUMN deleted_reason TEXT CHECK(deleted_reason IN ('manual','expired'));
ALTER TABLE operations ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 0 CHECK(fingerprint_version IN (0,1));
UPDATE resources SET deleted_reason='manual' WHERE state='deleted';
CREATE INDEX resources_expiration ON resources(expires_at,id) WHERE state IN ('pending','published') AND expires_at IS NOT NULL;
CREATE TABLE expiration_activation (
 id INTEGER PRIMARY KEY CHECK(id=1),
 activated_at INTEGER NOT NULL DEFAULT (unixepoch()),
 migrated_count INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER expiration_activate AFTER INSERT ON expiration_activation BEGIN
 UPDATE expiration_activation SET migrated_count=(SELECT count(*) FROM resources WHERE expiration_policy_version=0 AND state!='deleted') WHERE id=1;
 UPDATE resources SET expires_at=NEW.activated_at+2592000 WHERE expiration_policy_version=0 AND state!='deleted';
END;
CREATE TRIGGER expiration_legacy_insert AFTER INSERT ON resources WHEN NEW.expiration_policy_version=0 AND NEW.state!='deleted' AND EXISTS(SELECT 1 FROM expiration_activation WHERE id=1) BEGIN
 UPDATE resources SET expires_at=(SELECT activated_at+2592000 FROM expiration_activation WHERE id=1) WHERE id=NEW.id;
END;
CREATE TRIGGER expiration_first_insert AFTER INSERT ON resources WHEN NEW.expiration_policy_version=1 AND NEW.state='published' BEGIN
 SELECT RAISE(ABORT,'RETENTION_OVERFLOW') WHERE NEW.retention_seconds > 9007199254740991-unixepoch();
 UPDATE resources SET published_at=unixepoch(),expires_at=unixepoch()+NEW.retention_seconds WHERE id=NEW.id;
END;
CREATE TRIGGER expiration_publish_guard BEFORE UPDATE OF state ON resources WHEN OLD.state='pending' AND NEW.state='published' BEGIN
 SELECT RAISE(ABORT,'RESOURCE_EXPIRED') WHERE OLD.expires_at <= unixepoch();
 SELECT RAISE(ABORT,'RETENTION_OVERFLOW') WHERE OLD.expiration_policy_version=1 AND OLD.retention_seconds > 9007199254740991-unixepoch();
END;
CREATE TRIGGER expiration_first_publish AFTER UPDATE OF state ON resources WHEN OLD.state='pending' AND NEW.state='published' AND NEW.expiration_policy_version=1 BEGIN
 UPDATE resources SET published_at=unixepoch(),expires_at=unixepoch()+NEW.retention_seconds WHERE id=NEW.id;
END;
CREATE TRIGGER expiration_legacy_delete AFTER UPDATE OF state ON resources WHEN NEW.state='deleted' AND NEW.deleted_reason IS NULL BEGIN
 UPDATE resources SET deleted_reason='manual' WHERE id=NEW.id;
END;
CREATE TRIGGER expiration_deleted_insert AFTER INSERT ON resources WHEN NEW.state='deleted' AND NEW.deleted_reason IS NULL BEGIN
 UPDATE resources SET deleted_reason='manual' WHERE id=NEW.id;
END;
