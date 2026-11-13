/** v2 E1a (ADR 0042 decision 9): an icon name as LegendKeeper reads it, and as its write schema takes it. */
import { describe, expect, it } from 'vitest';
import { styleFields } from '../../src/maps/features.js';
import { isWriteIcon, toWriteIcon, withWriteIcon } from '../../src/lk/icons.js';

describe('toWriteIcon', () => {
  it.each([
    ['fas fa-book', 'book'],
    ['far fa-book', 'book'],
    ['fab fa-github', 'github'],
    ['fal fa-book', 'book'],
    ['fa-solid fa-book', 'book'],
    ['fa-regular fa-circle-user', 'circle-user'],
    ['fa-brands fa-discord', 'discord'],
    ['fa fa-book', 'book'],
    ['fa-book', 'book'],
    ['fas fa-book fa-fw', 'book'],
    ['  fas   fa-dragon ', 'dragon'],
    ['FAS FA-BOOK', 'BOOK'],
  ])('%s → %s', (read, write) => expect(toWriteIcon(read)).toBe(write));

  it.each(['book', 'crown', 'dog', 'circle-user', 'snowflake', 'hat-wizard', '42-group'])(
    'leaves the bare name %s alone',
    (name) => {
      expect(toWriteIcon(name)).toBe(name);
      expect(isWriteIcon(name)).toBe(true);
    },
  );

  it('leaves anything else as it is (LegendKeeper then judges it)', () => {
    expect(toWriteIcon('')).toBe('');
    expect(toWriteIcon('fas')).toBe('fas');
    expect(toWriteIcon('fa-')).toBe('fa-');
    expect(toWriteIcon(null)).toBeNull();
    expect(toWriteIcon(undefined)).toBeUndefined();
    expect(toWriteIcon(3)).toBe(3);
    expect(isWriteIcon('fas fa-book')).toBe(false);
  });

  it('withWriteIcon converts a body’s iconGlyph and touches nothing else (the same object when nothing changes)', () => {
    const body = { name: 'A', iconGlyph: 'fas fa-book', iconColor: '#112233', iconShape: 'pin' };
    expect(withWriteIcon(body)).toEqual({
      name: 'A',
      iconGlyph: 'book',
      iconColor: '#112233',
      iconShape: 'pin',
    });
    expect(body.iconGlyph).toBe('fas fa-book'); // the input is not changed
    const bare = { name: 'A', iconGlyph: 'book' };
    expect(withWriteIcon(bare)).toBe(bare);
    const none = { name: 'A' };
    expect(withWriteIcon(none)).toBe(none);
  });
});

describe('map pin styles', () => {
  it('the style fields both map tools send go out with the icon in the write form', () => {
    expect(styleFields({ iconGlyph: 'fas fa-skull', iconColor: '#aabbcc', iconShape: 'pin' })).toEqual({
      iconGlyph: 'skull',
      iconColor: '#aabbcc',
      iconShape: 'pin',
    });
    expect(styleFields({ iconGlyph: 'skull' })).toEqual({ iconGlyph: 'skull' });
    expect(styleFields(undefined)).toEqual({});
  });
});
