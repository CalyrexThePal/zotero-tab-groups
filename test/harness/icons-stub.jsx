// Stand-in for chrome/content/zotero/components/icons.jsx
import React from 'react';

export function CSSIcon({ name, className }) {
	return <span className={`icon icon-css icon-${name} ${className || ''}`} />;
}

export function CSSItemTypeIcon({ itemType, className }) {
	return <span className={`icon icon-css icon-item-type ${className || ''}`} data-item-type={itemType} />;
}
