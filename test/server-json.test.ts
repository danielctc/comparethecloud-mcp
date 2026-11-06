import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { expect, it } from 'vitest';
import schema from './fixtures/server.schema.json';
import server from '../server.json';
import { version } from '../package.json';

it('validates server.json against the unmodified official registry schema', () => {
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  expect(validate(server), JSON.stringify(validate.errors)).toBe(true);
  expect(server.version).toBe(version);
});
