CREATE INDEX `orderAuditLog_userId_idx` ON `orderAuditLog` (`userId`);--> statement-breakpoint
CREATE INDEX `orderAuditLog_createdAt_idx` ON `orderAuditLog` (`createdAt`);--> statement-breakpoint
CREATE INDEX `orderAuditLog_userId_createdAt_idx` ON `orderAuditLog` (`userId`,`createdAt`);