namespace ITrack.api.Dtos;

public class MarketSummaryDto
{
    public string Region { get; set; } = "ottawa";
    public int PeriodDays { get; set; } = 7;
    public MarketKpisDto Kpis { get; set; } = new();
    public MarketChartsDto Charts { get; set; } = new();
}

public class MarketKpisDto
{
    public int TotalJobs { get; set; }
    public int RemotePercentage { get; set; }
    public int MedianSalary { get; set; }
    public int HeatScore { get; set; }
}

public class MarketChartsDto
{
    public List<JobsByFieldPointDto> JobsByField { get; set; } = new();
    public List<JobsOverTimePointDto> JobsOverTime { get; set; } = new();
}

public class JobsByFieldPointDto
{
    public string Field { get; set; } = "";
    public int Count { get; set; }
}

public class JobsOverTimePointDto
{
    public string Date { get; set; } = "";  // depois a gente troca pra DateOnly/DateTime
    public int Count { get; set; }
}