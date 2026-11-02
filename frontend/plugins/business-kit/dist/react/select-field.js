import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useId } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
const { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } = hostUi();
export function SelectField({ options, id, label, placeholder = '请选择', hint, error, className, triggerClassName, 'aria-label': ariaLabel, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...props }) {
    const generatedId = useId(), controlId = id ?? generatedId;
    const description = [describedBy, hint ? `${controlId}-hint` : null, error ? `${controlId}-error` : null]
        .filter(Boolean).join(' ');
    return _jsxs("div", { className: cn('grid min-w-0 gap-2', className), children: [label !== undefined && _jsxs(Label, { htmlFor: controlId, children: [label, props.required && _jsx("span", { "aria-hidden": "true", className: "text-destructive", children: " *" })] }), _jsxs(Select, { ...props, children: [_jsx(SelectTrigger, { id: controlId, className: cn('w-full min-w-0', triggerClassName), "aria-label": ariaLabel, "aria-describedby": description || undefined, "aria-invalid": error ? true : ariaInvalid, "aria-required": props.required, children: _jsx(SelectValue, { placeholder: placeholder }) }), _jsx(SelectContent, { position: "popper", align: "start", children: options.map((option) => _jsx(SelectItem, { value: option.value, disabled: option.disabled ?? false, children: option.label }, option.value)) })] }), hint && _jsx("small", { id: `${controlId}-hint`, className: "text-xs text-muted-foreground", children: hint }), error && _jsx("small", { id: `${controlId}-error`, role: "alert", className: "text-xs text-destructive", children: error })] });
}
