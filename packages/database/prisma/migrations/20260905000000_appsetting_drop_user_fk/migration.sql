-- AppSetting is a global-or-per-user KV store by design: userId = "" denotes
-- a global setting. The foreign key to "User" made every global write fail
-- (no user with id ""), which silently broke the log-category cache and with
-- it every log-based sync. Drop the FK; the column keeps its default "".
ALTER TABLE "AppSetting" DROP CONSTRAINT IF EXISTS "AppSetting_userId_fkey";
