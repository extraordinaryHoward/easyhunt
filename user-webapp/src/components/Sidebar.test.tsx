import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Workbench';

afterEach(cleanup);
describe('cloud account navigation', () => {
  it('opens the received shares page from the account menu', () => {
    const navigate = vi.fn();
    render(<Sidebar page="projects" projects={[]} current={null} onPage={navigate} onProject={() => {}} localMode={false} balance={40}/>);
    fireEvent.click(screen.getByRole('button', { name: /云端账户/ }));
    fireEvent.click(screen.getByRole('button', { name: '与我分享' }));
    expect(navigate).toHaveBeenCalledWith('shared');
  });
});
