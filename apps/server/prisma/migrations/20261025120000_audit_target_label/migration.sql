-- 审计日志对象去 id 化：target 改存人类可读描述，机器引用挪到新列 targetType/targetId
ALTER TABLE "AuditLog" ADD COLUMN "targetType" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "targetId" TEXT;

-- 存量回填①：从旧格式 kind:id 解析出机器引用
UPDATE "AuditLog"
SET "targetType" = split_part(target, ':', 1),
    "targetId"  = substring(target from position(':' in target) + 1)
WHERE "targetType" IS NULL
  AND target LIKE '%:%'
  AND split_part(target, ':', 1) IN ('project', 'version', 'asset', 'user', 'comment', 'framelink', 'group');

-- 存量回填②：对象仍在库的，target 换成可读标签
UPDATE "AuditLog" a SET target = '项目「' || p.name || '」'
FROM "Project" p
WHERE a."targetType" = 'project' AND a."targetId" = p.id AND a.target LIKE 'project:%';

UPDATE "AuditLog" a SET target = '素材「' || ast.name || '」'
FROM "Asset" ast
WHERE a."targetType" = 'asset' AND a."targetId" = ast.id AND a.target LIKE 'asset:%';

UPDATE "AuditLog" a SET target = '版本 ' || ast.name || '-v' || v."versionNo"
FROM "AssetVersion" v JOIN "Asset" ast ON ast.id = v."assetId"
WHERE a."targetType" = 'version' AND a."targetId" = v.id AND a.target LIKE 'version:%';

UPDATE "AuditLog" a SET target = '用户 ' || u.name || COALESCE('（' || COALESCE(u.email, u.phone) || '）', '')
FROM "User" u
WHERE a."targetType" = 'user' AND a."targetId" = u.id AND a.target LIKE 'user:%';

UPDATE "AuditLog" a SET target = '批注 · 素材「' || ast.name || '」'
FROM "Comment" c JOIN "AssetVersion" v ON v.id = c."versionId" JOIN "Asset" ast ON ast.id = v."assetId"
WHERE a."targetType" = 'comment' AND a."targetId" = c.id AND a.target LIKE 'comment:%';

UPDATE "AuditLog" a SET target = '帧关联 · 素材「' || ast.name || '」'
FROM "FrameLink" fl JOIN "Asset" ast ON ast.id = fl."assetId"
WHERE a."targetType" = 'framelink' AND a."targetId" = fl.id AND a.target LIKE 'framelink:%';

UPDATE "AuditLog" SET target = '设置组「' || CASE "targetId"
    WHEN 'storage' THEN '存储' WHEN 'general' THEN '站点' WHEN 'security' THEN '安全'
    WHEN 'transcode' THEN '转码' WHEN 'feishu' THEN '飞书通知' ELSE "targetId" END || '」'
WHERE "targetType" = 'group' AND target LIKE 'group:%';

UPDATE "AuditLog" SET target = CASE target WHEN 'ok' THEN '飞书测试成功' ELSE '飞书测试失败' END
WHERE action = 'settings.feishu_test' AND target IN ('ok', 'fail');

-- 存量回填③：对象已删除、无法反查名称的旧行，至少不再显示裸 id
UPDATE "AuditLog" SET target = '批注（对象已删除）' WHERE "targetType" = 'comment' AND target LIKE 'comment:%';
UPDATE "AuditLog" SET target = '帧关联（对象已删除）' WHERE "targetType" = 'framelink' AND target LIKE 'framelink:%';
UPDATE "AuditLog" SET target = '版本（对象已删除）' WHERE "targetType" = 'version' AND target LIKE 'version:%';
UPDATE "AuditLog" SET target = '素材（对象已删除）' WHERE "targetType" = 'asset' AND target LIKE 'asset:%';
UPDATE "AuditLog" SET target = '项目（对象已删除）' WHERE "targetType" = 'project' AND target LIKE 'project:%';
UPDATE "AuditLog" SET target = '用户（已删除）' WHERE "targetType" = 'user' AND target LIKE 'user:%';

CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
