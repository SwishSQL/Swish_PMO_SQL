import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerEmail, ownerEmails, ownerName } from '../server/ownerEmails';

test('several owners: OWNER_EMAIL and OWNER_NAME take comma separated lists', () => {
  const was = { e: process.env.OWNER_EMAIL, n: process.env.OWNER_NAME };
  try {
    process.env.OWNER_EMAIL = ' Boss@Swishhh.net , fawzan@swishhh.net;boss@swishhh.net ';
    process.env.OWNER_NAME = 'The Boss';
    assert.deepEqual(ownerEmails(), ['boss@swishhh.net', 'fawzan@swishhh.net']);
    assert.equal(isOwnerEmail('BOSS@swishhh.net'), true);
    assert.equal(isOwnerEmail(' fawzan@swishhh.net'), true);
    assert.equal(isOwnerEmail('someone@swishhh.net'), false);
    assert.equal(ownerName('boss@swishhh.net'), 'The Boss');
    assert.equal(ownerName('fawzan@swishhh.net'), 'Fawzan', 'no name given: the start of the address');
    process.env.OWNER_EMAIL = '';
    assert.deepEqual(ownerEmails(), []);
    assert.equal(isOwnerEmail(''), false, 'an empty address is nobody');
  } finally {
    if (was.e === undefined) delete process.env.OWNER_EMAIL; else process.env.OWNER_EMAIL = was.e;
    if (was.n === undefined) delete process.env.OWNER_NAME; else process.env.OWNER_NAME = was.n;
  }
});
