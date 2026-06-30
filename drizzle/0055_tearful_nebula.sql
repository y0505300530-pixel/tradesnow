CREATE TABLE `pendingTotp` (
	`token` varchar(64) NOT NULL,
	`openId` varchar(64) NOT NULL,
	`expiresAt` bigint NOT NULL,
	CONSTRAINT `pendingTotp_token` PRIMARY KEY(`token`)
);
