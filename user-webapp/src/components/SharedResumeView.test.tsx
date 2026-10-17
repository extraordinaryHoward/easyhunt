import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud } from '../client';
import { SharedResumeView, type SharedResumeSummary } from './SharedResumeView';

vi.mock('../client', () => ({ cloud: vi.fn() }));
const request = vi.mocked(cloud);
const share: SharedResumeSummary = { id: 'share-1', resume_id: 'resume-1', display_name: '陈某', expires_at: '2030-01-01T00:00:00Z', permission: 'READ' };
beforeEach(() => request.mockReset());
afterEach(cleanup);

describe('received resume shares', () => {
  it('opens a READ share without exposing an edit action', async () => {
    request.mockResolvedValue({ content: { sourceText: '仅共享的文字' }, permission: 'READ', expiresAt: share.expires_at });
    render(<SharedResumeView share={share} onClose={() => {}} notify={() => {}}/>);
    expect(await screen.findByDisplayValue('仅共享的文字')).toBeDefined();
    expect((screen.getByLabelText('分享的简历文字') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull();
  });

  it('saves only explicitly shared text for an EDIT recipient', async () => {
    const notify = vi.fn();
    request.mockResolvedValueOnce({ content: { sourceText: '旧文字' }, permission: 'EDIT', expiresAt: share.expires_at }).mockResolvedValueOnce({ updated: true });
    render(<SharedResumeView share={{ ...share, permission: 'EDIT' }} onClose={() => {}} notify={notify}/>);
    const input = await screen.findByDisplayValue('旧文字');
    fireEvent.change(input, { target: { value: '新文字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('分享内容已保存'));
    expect(request).toHaveBeenLastCalledWith('/resume/resume-1/shares/share-1', 'PUT', { content: { sourceText: '新文字', document: null } });
  });
});
