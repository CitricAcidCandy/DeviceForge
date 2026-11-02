import type { ComponentProps, ReactNode } from 'react';
declare const Select: import("@deviceforge/plugin-sdk").HostComponent<import("@radix-ui/react-select").SelectSharedProps & {
    value?: string | undefined;
    defaultValue?: string | undefined;
    onValueChange?: {
        bivarianceHack(value: string): void;
    }["bivarianceHack"] | undefined;
}>;
export interface SelectFieldOption {
    readonly value: string;
    readonly label: ReactNode;
    readonly disabled?: boolean;
}
export type SelectFieldProps = Omit<ComponentProps<typeof Select>, 'children'> & {
    readonly options: readonly SelectFieldOption[];
    readonly id?: string;
    readonly label?: ReactNode;
    readonly placeholder?: string;
    readonly hint?: string;
    readonly error?: string;
    readonly className?: string;
    readonly triggerClassName?: string;
    readonly 'aria-label'?: string;
    readonly 'aria-describedby'?: string;
    readonly 'aria-invalid'?: boolean;
};
export declare function SelectField({ options, id, label, placeholder, hint, error, className, triggerClassName, 'aria-label': ariaLabel, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...props }: SelectFieldProps): import("react").JSX.Element;
export {};
