"use client";

import { useState } from "react";
import { getCollegeCatalog, majorSelectValue, CUSTOM_MAJOR, MAJOR_CATALOG_VERIFIED_AT } from "@/lib/college-majors";

// The parent keys this field by college: changing college resets transient input mode.
export default function MajorSelect({ college, major, onChange }: {
  college: string; major: string; onChange: (major: string) => void;
}) {
  const catalog = getCollegeCatalog(college);
  const [customMode, setCustomMode] = useState(false);
  const value = majorSelectValue(college, major, customMode);
  const isCustom = value === CUSTOM_MAJOR;
  return <div className="major-fields">
    <label className="form-field" htmlFor="profile-major">专业 <span>选填，仅在此设备保存</span>
      <select id="profile-major" aria-label="专业" aria-describedby="major-help" value={value} onChange={event => {
        const next = event.target.value;
        setCustomMode(next === CUSTOM_MAJOR);
        onChange(next === CUSTOM_MAJOR ? "" : next);
      }}>
        <option value="">{college === "暂不选择" ? "请先选择学院，也可手动填写" : "暂不选择专业"}</option>
        {catalog?.majors.map(name => <option key={name} value={name}>{name}</option>)}
        <option value={CUSTOM_MAJOR}>其他 / 未找到我的专业（手动填写）</option>
      </select>
    </label>
    {isCustom && <label className="form-field custom-major-field" htmlFor="profile-major-custom">填写专业名称
      <input id="profile-major-custom" aria-label="填写专业名称" value={major} maxLength={80} placeholder="输入你的专业名称" onChange={event => onChange(event.target.value)} />
    </label>}
    <p id="major-help" className="major-help">{catalog
      ? <>专业名单依据学院官网整理（{MAJOR_CATALOG_VERIFIED_AT} 核验）。{catalog.note} <a href={catalog.sources[0]} target="_blank" rel="noopener noreferrer">查看官方依据</a></>
      : "尚未收录该学院的完整专业名单，可选择“其他”手动填写。"} 切换学院后请重新选择专业。</p>
  </div>;
}
