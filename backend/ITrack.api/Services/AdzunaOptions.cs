namespace ITrack.api.Services;

public class AdzunaOptions
{
    public const string SectionName = "Adzuna";

    public string BaseUrl { get; set; } = "https://api.adzuna.com/v1/api/jobs";
    public string Country { get; set; } = "ca";
    public string AppId { get; set; } = "";
    public string AppKey { get; set; } = "";
    public int ResultsPerPage { get; set; } = 50;
}

