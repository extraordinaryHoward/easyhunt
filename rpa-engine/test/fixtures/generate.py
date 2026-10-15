"""Generate fictional, realistic PDF resumes for the local pipeline tests."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont('ArialUnicode', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
root = Path(__file__).parent
profiles = {
    'chen-wei.pdf': [
        '姓名：陈伟', '电话：13800001001', '邮箱：chen.wei@example.invalid', '期望城市：上海',
        '期望岗位：后端开发工程师', '期望薪资：30-40K/月', '工作年限：8年',
        '技能：Java，Spring Boot，Redis，PostgreSQL，Kafka',
        '工作经历：星河科技|高级后端工程师|2020-01~至今|负责订单系统',
        '教育经历：华东理工大学|本科|计算机科学与技术',
        '项目经历：设计交易链路，处理库存一致性，建设服务监控。',
    ],
    'lin-xiao.pdf': [
        '姓名：林晓', '电话：13800001002', '邮箱：lin.xiao@example.invalid', '期望城市：杭州',
        '期望岗位：后端开发工程师', '期望薪资：20-25K/月', '工作年限：3年',
        '技能：Java，Spring Boot，MySQL，Docker',
        '工作经历：青禾软件|后端开发工程师|2022-06~至今|开发客户管理接口',
        '教育经历：浙江工业大学|本科|软件工程',
        '项目经历：参与客户关系管理系统改造，负责接口测试与部署。',
    ],
    'wang-ning.pdf': [
        '姓名：王宁', '电话：13800001003', '邮箱：wang.ning@example.invalid', '期望城市：北京',
        '期望岗位：数据分析师', '期望薪资：15-20K/月', '工作年限：2年',
        '技能：Python，SQL，Tableau',
        '工作经历：云杉咨询|数据分析师|2023-02~至今|制作业务分析报表',
        '教育经历：北京信息职业技术学院|专科|数据分析',
        '项目经历：搭建销售指标报表，分析用户留存。',
    ],
}
for name, lines in profiles.items():
    c = canvas.Canvas(str(root / name), pagesize=(595, 842), pageCompression=0)
    c.setTitle(f'Easyhunt fixture - {name}')
    c.setFont('ArialUnicode', 16)
    c.drawString(48, 792, '候选人简历（虚构测试样本）')
    c.setFont('ArialUnicode', 10)
    y = 760
    for line in lines:
        if len(line) > 48:
            parts = [line[i:i+48] for i in range(0, len(line), 48)]
        else:
            parts = [line]
        for part in parts:
            c.drawString(48, y, part)
            y -= 18
    c.save()
