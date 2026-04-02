import { parseArgs } from 'node:util';
import { loadAppConfig } from '../config/index.js';
import { createDbPool } from '../persistence/db.js';
import { ensurePersistenceSchema } from '../persistence/schema.js';
import { createAuditLogStore } from '../persistence/queries/audit-log.js';
import { createIngestQuarantineStore } from '../persistence/queries/ingest-quarantine.js';
import { createProxyOverrideStore } from '../persistence/queries/proxy-overrides.js';
import { createWhaleWhitelistStore } from '../persistence/queries/whale-whitelist.js';

export async function runWhitelistCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) {
    throw new Error('whitelist requires an action: list | add | remove');
  }

  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const auditLogStore = createAuditLogStore(pool);
  const whitelistStore = createWhaleWhitelistStore(pool);

  try {
    await ensurePersistenceSchema(pool);

    if (action === 'list') {
      process.stdout.write(`${JSON.stringify(await whitelistStore.listEntries(), null, 2)}\n`);
      return;
    }

    if (action === 'add') {
      const parsed = parseArgs({
        args: rest,
        options: {
          address: { type: 'string' },
          label: { type: 'string' },
          reason: { type: 'string' },
        },
        allowPositionals: false,
      });

      const address = parsed.values.address;
      const label = parsed.values.label;
      const reason = parsed.values.reason;
      if (!address || !label || !reason) {
        throw new Error('whitelist add requires --address, --label, and --reason');
      }
      assertEvmAddress(address, '--address');

      const previousEntry = await whitelistStore.getEntry(address);
      const entry = await whitelistStore.upsertEntry({
        walletAddress: address,
        label,
        reason,
        addedBy: 'manual',
      });
      await auditLogStore.append({
        action: 'WHITELIST_ADD',
        targetAddress: address,
        actor: 'manual',
        oldValue: previousEntry,
        newValue: entry,
        reason,
      });
      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      return;
    }

    if (action === 'remove') {
      const parsed = parseArgs({
        args: rest,
        options: {
          address: { type: 'string' },
          reason: { type: 'string' },
        },
        allowPositionals: false,
      });

      const address = parsed.values.address;
      const reason = parsed.values.reason;
      if (!address || !reason) {
        throw new Error('whitelist remove requires --address and --reason');
      }
      assertEvmAddress(address, '--address');

      const removedEntry = await whitelistStore.removeEntry(address);
      if (removedEntry === null) {
        throw new Error(`No whitelist entry found for ${address}`);
      }

      await auditLogStore.append({
        action: 'WHITELIST_REMOVE',
        targetAddress: address,
        actor: 'manual',
        oldValue: removedEntry,
        newValue: null,
        reason,
      });
      process.stdout.write(`${JSON.stringify(removedEntry, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown whitelist action: ${action}`);
  } finally {
    await pool.end();
  }
}

export async function runProxyOverrideCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) {
    throw new Error('proxy-override requires an action: list | set | clear');
  }

  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const auditLogStore = createAuditLogStore(pool);
  const proxyOverrideStore = createProxyOverrideStore(pool);

  try {
    await ensurePersistenceSchema(pool);

    if (action === 'list') {
      process.stdout.write(`${JSON.stringify(await proxyOverrideStore.listEntries(), null, 2)}\n`);
      return;
    }

    if (action === 'set') {
      const parsed = parseArgs({
        args: rest,
        options: {
          address: { type: 'string' },
          controller: { type: 'string' },
          reason: { type: 'string' },
        },
        allowPositionals: false,
      });

      const address = parsed.values.address;
      const controller = parsed.values.controller;
      const reason = parsed.values.reason;
      if (!address || !controller || !reason) {
        throw new Error('proxy-override set requires --address, --controller, and --reason');
      }
      assertEvmAddress(address, '--address');
      assertEvmAddress(controller, '--controller');

      const previousOverride = await proxyOverrideStore.getOverride(address);
      const entry = await proxyOverrideStore.upsertOverride({
        contractAddress: address,
        controllerAddress: controller,
        reason,
        addedBy: 'manual',
      });
      await auditLogStore.append({
        action: 'PROXY_OVERRIDE_SET',
        targetAddress: address,
        actor: 'manual',
        oldValue: previousOverride,
        newValue: entry,
        reason,
      });
      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      return;
    }

    if (action === 'clear') {
      const parsed = parseArgs({
        args: rest,
        options: {
          address: { type: 'string' },
          reason: { type: 'string' },
        },
        allowPositionals: false,
      });

      const address = parsed.values.address;
      const reason = parsed.values.reason;
      if (!address || !reason) {
        throw new Error('proxy-override clear requires --address and --reason');
      }
      assertEvmAddress(address, '--address');

      const removedOverride = await proxyOverrideStore.clearOverride(address);
      if (removedOverride === null) {
        throw new Error(`No proxy override found for ${address}`);
      }

      await auditLogStore.append({
        action: 'PROXY_OVERRIDE_CLEAR',
        targetAddress: address,
        actor: 'manual',
        oldValue: removedOverride,
        newValue: null,
        reason,
      });
      process.stdout.write(`${JSON.stringify(removedOverride, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown proxy-override action: ${action}`);
  } finally {
    await pool.end();
  }
}

function assertEvmAddress(value: string, flagName: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value.trim())) {
    throw new Error(`${flagName} must be a 20-byte hex EVM address`);
  }
}

export async function runQuarantineCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) {
    throw new Error('quarantine requires an action: list | show');
  }

  const config = await loadAppConfig();
  const pool = createDbPool(config);
  const quarantineStore = createIngestQuarantineStore(pool);

  try {
    await ensurePersistenceSchema(pool);

    if (action === 'list') {
      const parsed = parseArgs({
        args: rest,
        options: {
          limit: { type: 'string', default: '50' },
        },
        allowPositionals: false,
      });

      const limit = Number(parsed.values.limit);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error('--limit must be a positive number');
      }

      process.stdout.write(`${JSON.stringify(await quarantineStore.listRecent(limit), null, 2)}\n`);
      return;
    }

    if (action === 'show') {
      const parsed = parseArgs({
        args: rest,
        options: {
          id: { type: 'string' },
        },
        allowPositionals: false,
      });

      const id = parsed.values.id;
      if (!id) {
        throw new Error('quarantine show requires --id');
      }

      const entry = await quarantineStore.getById(id);
      if (entry === null) {
        throw new Error(`No quarantine entry found for ${id}`);
      }

      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown quarantine action: ${action}`);
  } finally {
    await pool.end();
  }
}
