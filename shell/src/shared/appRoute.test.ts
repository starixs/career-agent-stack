import { describe, expect, it } from 'vitest';

import {
  createSpaceIssueAppRoute,
  createTaskCommentAppRoute,
  parseAppRouteUrl,
  serializeAppRoute,
} from './appRoute';

describe('AppRoute', () => {
  it('round-trips supported v1 routes', () => {
    const route = createSpaceIssueAppRoute('space_1', 'issue-2');
    expect(serializeAppRoute(route)).toBe(
      'keystone://open/v1/spaces/space_1/issues/issue-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(route))).toEqual(route);

    const commentRoute = createTaskCommentAppRoute('task_1', 'comment-2');
    expect(serializeAppRoute(commentRoute)).toBe(
      'keystone://open/v1/tasks/task_1/comments/comment-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(commentRoute))).toEqual(commentRoute);
  });

  it.each([
    'keystone://attachment/session/file.png',
    'keystone://tool-attachment/session/turn/file.png',
    'keystone-resource://attachment/session/file.png',
    'keystone://evil/v1/spaces/a/issues/b',
    'keystone://open/v2/spaces/a/issues/b',
    'keystone://open/v1/spaces/a/issues/b/extra',
    'keystone://open/v1/tasks/a/comments/b/extra',
    'keystone://open/v1/tasks/a/issues/b',
    'keystone://open/v1/spaces/a/issues/b?prompt=run',
    'keystone://open/v1/spaces/a/issues/b#fragment',
    'keystone://open/v1/spaces/a%2Fb/issues/c',
    'keystone://open/v1/spaces/a/issues/%ZZ',
    'keystone://user@open/v1/spaces/a/issues/b',
    'keystone://open:42/v1/spaces/a/issues/b',
  ])('rejects unsupported or ambiguous input: %s', (value) => {
    expect(parseAppRouteUrl(value)).toBeNull();
  });

  it('bounds identifiers before serialization', () => {
    expect(() => createSpaceIssueAppRoute('', 'issue')).toThrow();
    expect(() => createSpaceIssueAppRoute('space', 'x'.repeat(201))).toThrow();
    expect(() => createTaskCommentAppRoute('task', '')).toThrow();
  });
});
