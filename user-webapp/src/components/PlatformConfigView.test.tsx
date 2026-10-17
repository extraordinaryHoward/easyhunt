import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformConfigView } from './PlatformConfigView';

describe('platform configuration editor', () => {
  it('shows executable conditions and saves keywords in their edited order', () => {
    const change = vi.fn();
    const save = vi.fn();
    const view = render(<PlatformConfigView value={{ keywords: ['机器人', '系统工程师'], city: '深圳' }} onChange={change} jobs={[]} jobTitle="系统工程师" syncEnabled={false} onSync={()=>{}} onSave={save}/>);
    expect(screen.getByText('学历 · 待验证')).toBeDefined();
    expect(screen.getByText('学历 · 待验证').closest('button')?.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '上移系统工程师' }));
    expect(change.mock.calls[0][0].keywords).toEqual(['系统工程师', '机器人']);
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(save).toHaveBeenCalledOnce();
    view.unmount();
  });
});
