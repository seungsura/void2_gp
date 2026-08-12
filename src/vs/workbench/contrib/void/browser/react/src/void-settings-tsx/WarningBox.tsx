import { IconWarning } from '../sidebar-tsx/SidebarChat.js';


export const WarningBox = ({ text, onClick, className }: { text: string; onClick?: () => void; className?: string }) => {
	const content = <>
		<IconWarning
			size={14}
			className='mr-1 flex-shrink-0'
		/>
		<span>{text}</span>
	</>;
	const classes = `
		text-void-warning brightness-90 opacity-90 w-fit
		text-xs text-ellipsis
		${onClick ? `hover:brightness-75 transition-all duration-200 cursor-pointer focus-ring` : ''}
		flex items-center flex-nowrap
		${className}
	`;

	return onClick ? <button type='button' aria-label={text} title={text} className={classes} onClick={onClick}>{content}</button>
		: <div className={classes}>{content}</div>
	// return <VoidSelectBox
	// 	options={[{ text: 'Please add a model!', value: null }]}
	// 	onChangeSelection={() => { }}
	// />
}
