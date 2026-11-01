CREATE DATABASE IF NOT EXISTS sjsu_parking;
USE sjsu_parking;

CREATE TABLE IF NOT EXISTS parking_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    log_time DATETIME NOT NULL,
    garage_name VARCHAR(100) NOT NULL,
    fullness_percent TINYINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT chk_parking_history_fullness_percent
        CHECK (fullness_percent BETWEEN 0 AND 100),
    CONSTRAINT uq_parking_history_garage_log_time
        UNIQUE (garage_name, log_time),
    INDEX idx_parking_history_log_time (log_time)
) ENGINE=InnoDB;
