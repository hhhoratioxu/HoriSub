import assert from 'node:assert/strict';
import test from 'node:test';
import { trimDecoderRepetition } from '../src/providers/asr';

test('an expanding decoder loop leaves one caption without dropping distinct speech', () => {
  const phrase = 'This is a test of live captions.';
  const repeated = [phrase, phrase, phrase, phrase, 'This is a'].join(' ');
  assert.equal(trimDecoderRepetition(repeated), phrase);
  assert.equal(trimDecoderRepetition(phrase + ' ' + phrase), phrase + ' ' + phrase);
  assert.equal(trimDecoderRepetition(repeated + ' This matters.'), repeated + ' This matters.');
  assert.equal(trimDecoderRepetition('我不要，我不要，我不要。'), '我不要，我不要，我不要。');
});
