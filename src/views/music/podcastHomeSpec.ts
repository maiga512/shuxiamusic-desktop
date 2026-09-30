export interface PodcastCategorySpec {
  name: string
  officialCategoryNames?: string[]
  officialSecondNames?: string[]
  keywords?: string[]
}

export interface PodcastHomeBlockSpec {
  title: string
  subtitle: string
  accent: string
  subcategories: PodcastCategorySpec[]
}

export interface PodcastShelfSpec {
  title: string
  subtitle: string
  specs: PodcastCategorySpec[]
}

export const FM_CATEGORIES: PodcastCategorySpec[] = [
  { name: '历史解密', officialCategoryNames: ['人文历史', '知识', '文学出版'], keywords: ['历史解密', '历史疑案', '未解之谜'] },
  { name: '英语美文', officialCategoryNames: [], keywords: ['英语美文', '英文美文', '英语朗读'] },
  { name: '3D助眠', officialCategoryNames: ['生活', '情感', '亲子'], keywords: ['3D助眠', '白噪音', '助眠'] },
  { name: '热门翻唱', officialCategoryNames: ['创作翻唱', '音乐播客'], keywords: ['热门翻唱', '翻唱'] },
  { name: '悬疑罪案', officialCategoryNames: ['有声书', '故事'], keywords: ['悬疑罪案', '真实案件'] },
  { name: '娱乐影视', officialCategoryNames: ['娱乐', '脱口秀'], keywords: ['娱乐影视', '影视'] },
  { name: '搞笑段子', officialCategoryNames: ['脱口秀'], keywords: ['搞笑段子', '脱口秀'] },
  { name: '听见好书', officialCategoryNames: ['有声书'], keywords: ['听见好书', '有声书'] },
  { name: '新闻资讯', officialCategoryNames: ['资讯'], keywords: ['新闻资讯', '新闻'] },
  { name: '涨知识', officialCategoryNames: ['知识'], keywords: ['涨知识', '科普'] },
  { name: '睡前夜话', officialCategoryNames: ['生活', '情感', '亲子'], keywords: ['睡前夜话', '睡前故事'] },
  { name: '真实故事', officialCategoryNames: ['故事', '人文历史'], keywords: ['真实故事', '故事FM'] },
  { name: '相声小品', officialCategoryNames: ['相声曲艺'], keywords: ['相声小品', '相声'] }
]

export const HOME_SHELF: PodcastShelfSpec = {
  title: '猜你喜欢',
  subtitle: '网易云官方推荐播客',
  specs: [
    { name: '情感赫兹', officialCategoryNames: ['情感'], officialSecondNames: ['情感故事', '恋爱婚姻', '成长励志'], keywords: ['情感', '陪伴'] },
    { name: '睡前故事', officialCategoryNames: ['生活', '情感', '亲子'], officialSecondNames: ['绘本故事', '高效助眠', '情感故事'], keywords: ['睡前故事', '晚安'] },
    { name: '听见好书', officialCategoryNames: ['有声书'], officialSecondNames: ['热门有声书', '经典名著', '悬疑推理'], keywords: ['有声书', '听书'] },
    { name: '故事人文', officialCategoryNames: ['故事', '人文历史'], officialSecondNames: ['短篇故事', '历史', '人文'], keywords: ['故事', '人文'] }
  ]
}

export const HOME_BLOCKS: PodcastHomeBlockSpec[] = [
  {
    title: '精品播客',
    subtitle: '精品播客 0020141111',
    accent: '#E39B4A',
    subcategories: [
      { name: '精品播客', officialCategoryNames: ['精品播客'], keywords: ['精品播客', '精品'] }
    ]
  },
  {
    title: '听书剧场',
    subtitle: '有声书、睡前故事、悬疑罪案、真实故事归到一起',
    accent: '#8B7CF6',
    subcategories: [
      { name: '有声书', officialCategoryNames: ['有声书'], keywords: ['有声书', '听书'] },
      { name: '文学出版', officialCategoryNames: ['文学出版'], keywords: ['文学出版', '读书'] },
      { name: '睡前故事', officialCategoryNames: ['生活', '情感', '亲子'], keywords: ['睡前故事', '晚安故事'] },
      { name: '悬疑罪案', officialCategoryNames: ['有声书', '故事'], keywords: ['悬疑罪案', '真实案件'] },
      { name: '真实故事', officialCategoryNames: ['故事', '人文历史'], keywords: ['真实故事', '人间故事'] }
    ]
  },
  {
    title: '知识成长',
    subtitle: '知识、科普、学习成长和职业观察，走官方知识分类',
    accent: '#3CB371',
    subcategories: [
      { name: '知识', officialCategoryNames: ['知识'], keywords: ['知识', '学习'] },
      { name: '涨知识', officialCategoryNames: ['知识'], keywords: ['涨知识', '科普'] },
      { name: '职业观察', officialCategoryNames: ['知识'], keywords: ['职业', '行业'] },
      { name: '心理成长', officialCategoryNames: ['知识'], keywords: ['心理', '成长'] }
    ]
  },
  {
    title: '故事人文',
    subtitle: '故事、人文历史、纪实和文化类播客分开归类',
    accent: '#E39B4A',
    subcategories: [
      { name: '故事', officialCategoryNames: ['故事'], keywords: ['故事', '故事FM'] },
      { name: '人文历史', officialCategoryNames: ['人文历史'], keywords: ['人文历史', '历史'] },
      { name: '历史解密', officialCategoryNames: ['人文历史'], keywords: ['历史解密', '未解之谜'] },
      { name: '名家散文', officialCategoryNames: ['人文历史', '文学出版'], keywords: ['名家散文', '散文'] }
    ]
  },
  {
    title: '情感资讯',
    subtitle: '情感、新闻资讯和生活陪伴类内容独立展示',
    accent: '#B8C0C9',
    subcategories: [
      { name: '情感', officialCategoryNames: ['情感'], keywords: ['情感', '晚安'] },
      { name: '睡前夜话', officialCategoryNames: ['生活', '情感'], keywords: ['睡前夜话', '夜话'] },
      { name: '新闻资讯', officialCategoryNames: ['资讯'], keywords: ['新闻资讯', '热点'] },
      { name: '双语新闻', officialCategoryNames: [], keywords: ['双语新闻', '英语新闻'] }
    ]
  },
  {
    title: '英语美文',
    subtitle: '朗读、双语新闻、TED、磨耳朵这些英语内容集中展示',
    accent: '#4C8DFF',
    subcategories: [
      { name: '英语美文', officialCategoryNames: [], keywords: ['英语美文', '英语朗读'] },
      { name: '双语新闻', officialCategoryNames: [], keywords: ['双语新闻', 'BBC英语'] },
      { name: 'TED英语', officialCategoryNames: [], keywords: ['TED英语', 'TED演讲'] },
      { name: '磨耳朵', officialCategoryNames: [], keywords: ['英语听力', '英语磨耳朵'] }
    ]
  },
  {
    title: '脱口秀',
    subtitle: '段子、吐槽、喜剧、热门脱口秀优先走网易电台真实结果',
    accent: '#E39B4A',
    subcategories: [
      { name: '脱口秀', officialCategoryNames: ['脱口秀'], keywords: ['脱口秀', '脱口秀大会'] },
      { name: '吐槽喜剧', officialCategoryNames: ['脱口秀'], keywords: ['吐槽', '喜剧'] },
      { name: '高分喜剧', officialCategoryNames: ['脱口秀', '相声曲艺'], keywords: ['高分喜剧', '搞笑段子'] },
      { name: '娱乐闲聊', officialCategoryNames: ['娱乐', '脱口秀'], keywords: ['娱乐闲聊', '娱乐播客'] }
    ]
  },
  {
    title: '相声曲艺',
    subtitle: '相声、小品、曲艺和经典专场，适合车上长听',
    accent: '#3CB371',
    subcategories: [
      { name: '相声曲艺', officialCategoryNames: ['相声曲艺'], keywords: ['相声曲艺', '相声'] },
      { name: '相声小品', officialCategoryNames: ['相声曲艺'], keywords: ['相声小品', '小品'] },
      { name: '郭德纲于谦', officialCategoryNames: ['相声曲艺'], keywords: ['郭德纲于谦', '德云社'] },
      { name: '评书故事', officialCategoryNames: ['相声曲艺', '有声书'], keywords: ['评书', '评书故事'] }
    ]
  }
]
