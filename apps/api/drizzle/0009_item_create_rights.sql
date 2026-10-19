-- Only Stores and Super Admin create inventory items (prevents duplicate items). Management keeps view/edit.
UPDATE "roles" SET "permissions" = array_remove("permissions", 'items:create') WHERE "name" NOT IN ('Super Admin', 'Purchase & Stores');
