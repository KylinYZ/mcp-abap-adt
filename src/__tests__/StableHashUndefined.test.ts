// stableHash 深对比健壮性测试：undefined 键缺失场景的真机回归（SET_DATA_ELEMENT_PROPERTIES 标签 500 修复）
import { changedFieldPaths, stableHash, stableJson } from '../safe/advancedWorkflowTools';

describe('stableJson / changedFieldPaths undefined handling', () => {
  it('hashes undefined to a stable literal instead of crashing Hash.update', () => {
    expect(stableJson(undefined)).toBe('null');
    expect(() => stableHash(undefined)).not.toThrow();
    expect(stableHash(undefined)).toBe(stableHash(null));
  });

  it('reports a changed path when one side lacks the key (mixed label shape)', () => {
    // 真机形态：服务器读回的 fieldLabels 带 *FieldLength，提交侧不带——一侧键缺失
    const current = { properties: { fieldLabels: { shortFieldLabel: 'A', shortFieldLength: 10 } } };
    const proposed = { properties: { fieldLabels: { shortFieldLabel: 'B' } } };
    const paths = changedFieldPaths(current, proposed);
    expect(paths).toContain('properties.fieldLabels.shortFieldLabel');
    expect(paths).toContain('properties.fieldLabels.shortFieldLength');
  });
});
