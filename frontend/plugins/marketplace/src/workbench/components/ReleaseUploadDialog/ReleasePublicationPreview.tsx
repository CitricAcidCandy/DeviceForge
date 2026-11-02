import type { ReleasePublicationPlan } from '../../release-publication/index.ts';

export function ReleasePublicationPreview({ plan }: { plan: ReleasePublicationPlan }) {
  const { manifest } = plan;
  return (
    <section aria-label="完整功能插件预览" className="grid gap-4">
      <div>
        <h3 className="font-semibold">{manifest.name}</h3>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{manifest.description}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt>发布 ID</dt><dd className="break-all font-mono">{manifest.id}</dd>
        <dt>发布版本</dt><dd className="break-all font-mono">{manifest.version}</dd>
        <dt>完整 ZIP</dt><dd className="break-all">{plan.file.name} · {plan.file.size.toLocaleString('zh-CN')} 字节</dd>
        <dt>依赖资源总量</dt><dd>{plan.resources.length} 项 · {plan.totalResourceBytes.toLocaleString('zh-CN')} 字节</dd>
        <dt>清单 SHA-256</dt><dd className="break-all font-mono">{plan.manifestSha256}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        发布 ID、版本、名称和描述来自清单，保持原值。修改这些信息需要重新打包完整 ZIP。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <section aria-label="发布组件" className="grid content-start gap-2">
          <h4 className="text-sm font-medium">组件（{manifest.components.length}）</h4>
          <ul className="grid gap-2 text-sm">
            {manifest.components.map((component) => (
              <li key={`${component.kind}:${component.id}`} className="rounded border p-3">
                <p className="break-all">{component.kind === 'server' ? '服务器组件' : '浏览器组件'} · {component.id}</p>
                <p className="text-muted-foreground">版本 {component.version} · {component.variants.length} 个平台变体</p>
                {component.variants.map((variant) => <p className="break-all text-muted-foreground" key={variant.path}>{variant.platform} · {variant.size.toLocaleString('zh-CN')} 字节</p>)}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="发布工具" className="grid content-start gap-2">
          <h4 className="text-sm font-medium">工具（{manifest.tools.length}）</h4>
          {manifest.tools.length === 0 ? <p className="text-sm text-muted-foreground">此发布不包含依赖工具。</p> : (
            <ul className="grid gap-2 text-sm">
              {manifest.tools.map((tool) => (
                <li key={tool.id} className="rounded border p-3">
                  <p className="break-all">{tool.id} · {tool.version} · {tool.required ? '必需' : '可选'}</p>
                  {tool.variants.map((variant) => <p className="break-all text-muted-foreground" key={variant.path}>{variant.platform} · {variant.size.toLocaleString('zh-CN')} 字节</p>)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section aria-label="所需用户输入" className="grid gap-2">
        <h4 className="text-sm font-medium">所需用户输入（{manifest.requirements.length}）</h4>
        {manifest.requirements.length === 0 ? <p className="text-sm text-muted-foreground">清单未声明额外用户输入。</p> : (
          <ul className="grid gap-2 text-sm">
            {manifest.requirements.map((requirement) => (
              <li key={`${requirement.component_id}:${requirement.config_pointer}`} className="rounded border p-3">
                <p>{requirement.title} · {requirement.required ? '必填' : '选填'}{requirement.sensitive ? ' · 敏感信息，由用户安装后配置' : ''}</p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">{requirement.description}</p>
                <p className="break-all font-mono text-xs text-muted-foreground">{requirement.component_id} · {requirement.config_pointer}</p>
                {!!requirement.any_of?.length && <p className="break-all text-muted-foreground">也可配置以下任一路径：{requirement.any_of.join('、')}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <details>
        <summary className="cursor-pointer text-sm">资源摘要（{plan.resources.length} 项）</summary>
        <ul className="mt-2 grid max-h-48 gap-2 overflow-y-auto text-xs">
          {plan.resources.map((resource) => (
            <li key={resource.path} className="break-all rounded border p-2">
              <p>{resource.path} · {resource.size.toLocaleString('zh-CN')} 字节</p>
              <p className="font-mono">SHA-256：{resource.sha256}</p>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
