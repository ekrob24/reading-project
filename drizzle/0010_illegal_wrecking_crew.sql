CREATE TABLE `readingMaterialDetails` (
	`id` int AUTO_INCREMENT NOT NULL,
	`materialId` int NOT NULL,
	`author` varchar(180) NOT NULL,
	`rightsSource` enum('original','public_domain','permission_obtained') NOT NULL,
	`interestAge` varchar(80) NOT NULL,
	`genre` varchar(80) NOT NULL,
	`lifecycleStatus` enum('draft','teacher_approved','assignable') NOT NULL DEFAULT 'draft',
	`approvedByUserId` int,
	`approvedAt` timestamp,
	`assignableAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `readingMaterialDetails_id` PRIMARY KEY(`id`),
	CONSTRAINT `readingMaterialDetails_materialId_unique` UNIQUE(`materialId`)
);
--> statement-breakpoint
ALTER TABLE `readingMaterialDetails` ADD CONSTRAINT `readingMaterialDetails_materialId_readingMaterials_id_fk` FOREIGN KEY (`materialId`) REFERENCES `readingMaterials`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `readingMaterialDetails` ADD CONSTRAINT `readingMaterialDetails_approvedByUserId_users_id_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;