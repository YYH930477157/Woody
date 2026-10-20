import React from 'react';

/** Icon-park icons do not get Arco's `.arco-icon` spacing inside buttons; pair them with text explicitly. */
export default function IconText({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className='inline-flex items-center gap-6px'>
      {icon}
      <span>{children}</span>
    </span>
  );
}
